type Owner = {
    agentId: string;
    workspaceDir?: string;
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
