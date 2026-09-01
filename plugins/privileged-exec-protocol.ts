/**
 * Compatibility no-op for the briefly installed top-level protocol module.
 * Shared broker protocol code now lives under agent-teams/ so pi does not
 * auto-discover it as an extension. This file can be removed after all older
 * runtime backups/sessions are retired.
 */
export default function privilegedExecProtocolCompatibilityExtension(): void {}
