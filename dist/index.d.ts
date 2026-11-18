import { Type, type Static } from "typebox";
declare const configSchema: Type.TObject<{
    proxies: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
        server: Type.TString;
        username: Type.TOptional<Type.TString>;
        passwordEnv: Type.TOptional<Type.TString>;
        bypass: Type.TOptional<Type.TString>;
    }>>>;
    allowPrivateNetwork: Type.TOptional<Type.TBoolean>;
    allowedPrivateHosts: Type.TOptional<Type.TArray<Type.TString>>;
}>;
type PluginConfig = Static<typeof configSchema>;
type Owner = {
    agentId: string;
    workspaceDir?: string;
};
type NetSettings = {
    allowPrivate: boolean;
    allowHosts: readonly string[];
};
/**
 * Resolve the profile name for (agentId, session). Names that already start with the
 * agent id ("buyer", "buyer-checkout") are kept as-is so existing profiles keep working;
 * anything else is prefixed ("bookings" from main -> "main-bookings"). The result always
 * equals the agent id or starts with "<agentId>-", so agents cannot reach each other's
 * profiles. A name that would fall inside a longer agent id's namespace
 * (agent "shop" + session "us-x" vs agent "shop-us") is refused.
 */
export declare function resolveSessionName(agentId: string, session: string | undefined, agentIds?: readonly string[]): string;
/** Workspace files are served to Chrome from this virtual origin, so Chrome itself never opens file:// URLs. */
export declare const WORKSPACE_ORIGIN = "http://workspace.patchright.invalid";
/** True for loopback, private, link-local, CGNAT, multicast, reserved and other non-public addresses. */
export declare function isBlockedAddress(address: string): boolean;
export declare function netSettingsFrom(config: PluginConfig | undefined): NetSettings;
/**
 * Why Chrome may not load this URL, or null when it may. By default only http(s) to public
 * addresses passes: hostnames are resolved and every address they map to is checked.
 */
export declare function checkRemoteUrl(raw: string, net: NetSettings): Promise<string | null>;
/** A model-supplied inline proxy must not point at a local or private address (use a configured proxyProfile). */
export declare function checkProxyServer(server: string, net: NetSettings): Promise<string | null>;
/**
 * Map a model-supplied URL to what Chrome may load: http(s) to allowed addresses as-is, a file:// URL
 * inside the agent's workspace via the virtual workspace origin, or about:blank. Anything else is refused.
 */
export declare function resolveNavigationTarget(raw: string, workspaceRoot: string | undefined, net: NetSettings): Promise<string>;
/** Resolve a workspace-origin URL to a regular file inside the workspace (symlinks resolved), or null. */
export declare function workspaceFileFor(url: string, workspaceRoot: string | undefined): Promise<string | null>;
export declare const ALLOWED_CHROME_ARGS: string[];
/** Chrome flags from the model are limited to a small display-only allowlist. */
export declare function checkChromeArgs(args: readonly string[] | undefined): string[];
/** Close every browser this plugin launched (plugin dispose / gateway shutdown). */
export declare function closeAllSessions(): Promise<void>;
/**
 * Screenshots may only be written under the plugin's media dir or the calling agent's
 * workspace. Relative paths resolve against the workspace (or the media dir).
 */
export declare function resolveScreenshotPath(requested: string | undefined, owner: Owner, name: string): Promise<string>;
/** Expressions that are function literals are called; everything else is evaluated as-is. */
export declare function toEvaluationSource(expression: string): string;
declare const entry: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default entry;
