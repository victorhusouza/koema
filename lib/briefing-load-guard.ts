/** Prevent a deferred briefing response from replacing a newer draft or date. */
export function canApplyBriefingLoad(input: {
 requestId: number;
 currentRequestId: number;
 loadedVersion: number;
 currentVersion: number;
}): boolean {
 return input.requestId === input.currentRequestId && input.loadedVersion === input.currentVersion;
}
