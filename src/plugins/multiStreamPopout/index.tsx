/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { ScreenshareIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Stream } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelRTCStore, ContextMenuApi, Menu, PopoutWindowStore, React, SelectedChannelStore, UserStore } from "@webpack/common";

const logger = new Logger("MultiStreamPopout");

// Discord's own "Pop Out Stream" flow: watch the stream (without dropping the others),
// mark the tile as popped out, then open a call tile popout window keyed per participant.
const watchStream: (stream: Stream, options?: { forceMultiple?: boolean; noFocus?: boolean; }) => void =
    findByCodeLazy('type:"STREAM_WATCH",streamKey', "forceMultiple");
interface ChannelRTCActions {
    popoutParticipant(channelId: string, participantId: string): void;
    returnParticipant(channelId: string, participantId: string): void;
}
const ChannelRTCActions: ChannelRTCActions = findByPropsLazy("popoutParticipant", "returnParticipant");
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

// Every open call tile popout, keyed by window key. A window can show a different
// stream than the one it was opened for, and several windows can show the same stream.
interface TileWindow {
    channelId: string;
    participantId: string;
    setParticipantId(participantId: string): void;
}
const tileWindows = new Map<string, TileWindow>();
let WindowKeyContext: React.Context<string | null> | undefined;
const getWindowKeyContext = () => WindowKeyContext ??= React.createContext<string | null>(null);

function countWindowsShowing(channelId: string, participantId: string) {
    let count = 0;
    for (const win of tileWindows.values())
        if (win.channelId === channelId && win.participantId === participantId) count++;
    return count;
}

function getStreamerName({ ownerId }: Stream) {
    const user = UserStore.getUser(ownerId);
    return user?.globalName ?? user?.username ?? "Unknown";
}

function switchStream(windowKey: string, stream: Stream) {
    const win = tileWindows.get(windowKey);
    const next = getStreamKey(stream);
    if (!win || win.participantId === next) return;

    const prev = win.participantId;
    win.participantId = next;
    win.setParticipantId(next);

    try {
        watchStream(stream, { forceMultiple: true, noFocus: true });
        if (!ChannelRTCStore.isParticipantPoppedOut(win.channelId, next))
            ChannelRTCActions.popoutParticipant(win.channelId, next);
        if (countWindowsShowing(win.channelId, prev) === 0)
            ChannelRTCActions.returnParticipant(win.channelId, prev);
    } catch (e) {
        logger.error("Failed to switch stream", next, e);
    }
}

function getSwitchItems(windowKey: string) {
    const win = tileWindows.get(windowKey);
    if (!win) return [];

    const others = getChannelStreams(win.channelId).filter(stream => getStreamKey(stream) !== win.participantId);
    if (!others.length)
        return [<Menu.MenuItem key="none" id="vc-multi-stream-switch-none" label="No other streams" disabled />];

    return others.map(stream => {
        const key = getStreamKey(stream);
        const elsewhere = countWindowsShowing(win.channelId, key) > 0;

        return (
            <Menu.MenuItem
                key={key}
                id={`vc-multi-stream-switch-${key}`}
                label={elsewhere ? `${getStreamerName(stream)} (open in another window)` : getStreamerName(stream)}
                action={() => switchStream(windowKey, stream)}
            />
        );
    });
}

// Discord's typings don't include the context option, which picks the window the menu opens in
const openContextMenu = ContextMenuApi.openContextMenu as unknown as
    (event: React.MouseEvent, render: () => React.ReactNode, options: { context: string; }) => void;

function openSwitcher(event: React.MouseEvent) {
    const view = event.currentTarget.ownerDocument.defaultView;
    const windowKey = [...tileWindows.keys()].find(key => PopoutWindowStore.getWindow(key) === view);
    if (!windowKey) return;

    openContextMenu(event, () => (
        <Menu.Menu navId="vc-multi-stream-switcher" onClose={ContextMenuApi.closeContextMenu} aria-label="Switch Stream">
            {getSwitchItems(windowKey)}
        </Menu.Menu>
    ), { context: "CALL_TILE_POPOUT" });
}

const streamContextPatch: NavContextMenuPatchCallback = (children, { stream, appContext }: { stream?: Stream; appContext?: string; }) => {
    if (!stream) return;

    if (appContext === "CALL_TILE_POPOUT") {
        const key = getStreamKey(stream);
        const showing = [...tileWindows].filter(([, win]) => win.participantId === key).map(([windowKey]) => windowKey);
        const windowKey = showing.find(k => PopoutWindowStore.getWindowFocused(k)) ?? showing[0];

        if (windowKey)
            children.push(
                <Menu.MenuItem id="vc-multi-stream-switch" label="Switch Stream">
                    {getSwitchItems(windowKey)}
                </Menu.MenuItem>
            );
    }

    addPopoutAllStreamsItem(children, stream.channelId);
};

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    // Only offer this for the call you are actually in, since popping out requires watching
    if (!channel || channel.id !== SelectedChannelStore.getVoiceChannelId()) return;

    addPopoutAllStreamsItem(children, channel.id);
};

// Right clicking a DM in the DM list opens the user menu, which is also used everywhere else
const userContextPatch: NavContextMenuPatchCallback = (children, props: { channel?: Channel; }) => {
    if (props.channel?.isDM()) channelContextPatch(children, props);
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

    settingsAboutComponent: () => (
        <Paragraph size="md">
            Right click a stream, or the voice channel, DM or group you're in a call in, and click "Pop Out All Streams". Click a popout to switch its stream.
        </Paragraph>
    ),

    patches: [
        {
            // The popout window for a single call tile
            find: ",focused:!0,noBorder:!0,onContextMenu:",
            replacement: [
                {
                    // Let the window change which stream it shows
                    match: /(let\{windowKey:\i,channelId:\i,participantId:\i\}=)(\i)/,
                    replace: "$1$self.useSwitchedStream($2)"
                },
                {
                    // Keep a stream out of the call grid while another window still shows it
                    match: /(\i\.\i)\.returnParticipant\((\i),(\i)\)/,
                    replace: "$self.returnParticipant($1,$2,$3)"
                },
                {
                    // Clicking a stream you're already watching opens the stream switcher
                    match: /onClick:(\i)\?(\i):void 0/,
                    replace: "onClick:$1?$2:$self.openSwitcher"
                },
                {
                    match: /(?<=let\{windowKey:(\i),.+?)children:(\i)\?(\(0,\i\.jsx\)\(\i\.\i\.Provider,.+?):null\}\)/,
                    replace: "children:$2?$self.provideWindowKey($1,$3):null})"
                }
            ]
        },
        {
            // The stay on top and close buttons look up their window by stream, which breaks once a window switches
            find: '"stay-on-top"',
            replacement: [
                {
                    match: /(?<=participantId:\i,hideWhenInactive:\i,idle:\i\}=\i,)(\i)=\i\.useMemo\(\(\)=>(\(0,\i\.\i\)\(\i,\i\)),\[\i,\i\]\)/,
                    replace: "$1=$self.useTileWindowKey($2)"
                },
                {
                    match: /\.close\((\(0,\i\.\i\)\(\i\.id,\i\))\)/,
                    replace: ".close($self.getFocusedTileWindowKey($1))"
                }
            ]
        },
        {
            // A stream's usual window may now show another stream, so open it in a new window instead of focusing that one
            find: "handleOpenCallTilePopout=",
            replacement: {
                match: /(handleOpenCallTilePopout=\i=>\{let\{channelId:\i,participantId:(\i)\}=\i,\i=)(\(0,\i\.\i\)\(\i,\i\))/,
                replace: "$1$self.getFreeTileWindowKey($3,$2)"
            }
        }
    ],

    useSwitchedStream(props: { windowKey: string; channelId: string; participantId: string; }) {
        const [participantId, setParticipantId] = React.useState(props.participantId);
        tileWindows.set(props.windowKey, { channelId: props.channelId, participantId, setParticipantId });
        React.useEffect(() => () => void tileWindows.delete(props.windowKey), [props.windowKey]);

        return { ...props, participantId };
    },

    returnParticipant(actions: ChannelRTCActions, channelId: string, participantId: string) {
        // The closing window is still registered, so more than one means another window shows it
        if (countWindowsShowing(channelId, participantId) > 1) return;
        actions.returnParticipant(channelId, participantId);
    },

    openSwitcher,

    provideWindowKey(windowKey: string, children: React.ReactNode) {
        const { Provider } = getWindowKeyContext();
        return <Provider value={windowKey}>{children}</Provider>;
    },

    useTileWindowKey(fallback: string) {
        return React.useContext(getWindowKeyContext()) ?? fallback;
    },

    getFocusedTileWindowKey(fallback: string) {
        return [...tileWindows.keys()].find(key => PopoutWindowStore.getWindowFocused(key)) ?? fallback;
    },

    getFreeTileWindowKey(baseKey: string, participantId: string) {
        let key = baseKey;
        for (let i = 2; PopoutWindowStore.getWindowOpen(key) && (tileWindows.get(key)?.participantId ?? participantId) !== participantId; i++)
            key = `${baseKey}_${i}`;
        return key;
    },

    contextMenus: {
        "stream-context": streamContextPatch,
        "channel-context": channelContextPatch,
        "gdm-context": channelContextPatch,
        "user-context": userContextPatch
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
