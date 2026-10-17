/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { ScreenshareIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Stream } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelRTCStore, Menu, SelectedChannelStore, UserStore } from "@webpack/common";

const logger = new Logger("MultiStreamPopout");

// Discord's own "Pop Out Stream" flow: watch the stream (without dropping the others),
// mark the tile as popped out, then open a call tile popout window keyed per participant.
const watchStream: (stream: Stream, options?: { forceMultiple?: boolean; noFocus?: boolean; }) => void =
    findByCodeLazy('type:"STREAM_WATCH",streamKey', "forceMultiple");
const ChannelRTCActions: { popoutParticipant(channelId: string, participantId: string): void; } =
    findByPropsLazy("popoutParticipant", "returnParticipant");
const CallTilePopoutActions: { openCallTilePopout(channelId: string, participantId: string): void; } =
    findByPropsLazy("openCallTilePopout");

const settings = definePluginSettings({
    autoPopout: {
        description: "Automatically open a separate popout for every stream in your current voice channel",
        type: OptionType.BOOLEAN,
        default: false
    },
    includeOwnStream: {
        description: "Also pop out your own stream",
        type: OptionType.BOOLEAN,
        default: false
    }
});

function getStreamKey({ streamType, guildId, channelId, ownerId }: Stream) {
    return streamType === "guild"
        ? `guild:${guildId}:${channelId}:${ownerId}`
        : `call:${channelId}:${ownerId}`;
}

function getChannelStreams(channelId: string) {
    const myId = UserStore.getCurrentUser()?.id;

    return ApplicationStreamingStore.getAllApplicationStreamsForChannel(channelId)
        .filter(stream => settings.store.includeOwnStream || stream.ownerId !== myId);
}

function isPoppedOut(stream: Stream) {
    return ChannelRTCStore.isParticipantPoppedOut(stream.channelId, getStreamKey(stream));
}

function getPoppableStreams(channelId: string) {
    return getChannelStreams(channelId).filter(stream => !isPoppedOut(stream));
}

function popoutStream(stream: Stream) {
    const streamKey = getStreamKey(stream);

    try {
        watchStream(stream, { forceMultiple: true, noFocus: true });
        ChannelRTCActions.popoutParticipant(stream.channelId, streamKey);
        CallTilePopoutActions.openCallTilePopout(stream.channelId, streamKey);
    } catch (e) {
        logger.error("Failed to pop out stream", streamKey, e);
    }
}

function popoutAllStreams(channelId: string) {
    getPoppableStreams(channelId).forEach(popoutStream);
}

// Discord's Menu only accepts its own item elements as children, so this must be
// called as a plain function rather than rendered as a custom component
function addPopoutAllStreamsItem(children: Parameters<NavContextMenuPatchCallback>[0], channelId: string) {
    const count = getPoppableStreams(channelId).length;
    if (count < 1) return;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem
            id="vc-multi-stream-popout"
            label={count === 1 ? "Pop Out Stream" : `Pop Out All Streams (${count})`}
            icon={ScreenshareIcon}
            leadingAccessory={{ type: "icon", icon: ScreenshareIcon }}
            action={() => popoutAllStreams(channelId)}
        />
    );
}

const streamContextPatch: NavContextMenuPatchCallback = (children, { stream }: { stream?: Stream; }) => {
    if (!stream) return;

    addPopoutAllStreamsItem(children, stream.channelId);
};

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    // Only offer this for the call you are actually in, since popping out requires watching
    if (!channel || channel.id !== SelectedChannelStore.getVoiceChannelId()) return;

    addPopoutAllStreamsItem(children, channel.id);
};

let knownStreamKeys = new Set<string>();

function onStreamsChange() {
    if (!settings.store.autoPopout) return;

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) {
        knownStreamKeys = new Set();
        return;
    }

    const streams = getChannelStreams(channelId);
    // Only open new streams, so closing a popout by hand doesn't immediately reopen it
    const newStreams = streams.filter(stream => !knownStreamKeys.has(getStreamKey(stream)));
    knownStreamKeys = new Set(streams.map(getStreamKey));

    if (!newStreams.length) return;

    // Change listeners run mid-dispatch, and popping out dispatches its own actions
    setTimeout(() => newStreams.filter(stream => !isPoppedOut(stream)).forEach(popoutStream));
}

export default definePlugin({
    name: "MultiStreamPopout",
    description: "Watch every stream in a voice channel at once, each in its own popout window",
    tags: ["Voice", "Media"],
    authors: [Devs.Bellatorius],
    settings,

    contextMenus: {
        "stream-context": streamContextPatch,
        "channel-context": channelContextPatch
    },

    start() {
        knownStreamKeys = new Set();
        ApplicationStreamingStore.addChangeListener(onStreamsChange);
    },

    stop() {
        ApplicationStreamingStore.removeChangeListener(onStreamsChange);
        knownStreamKeys.clear();
    }
});
