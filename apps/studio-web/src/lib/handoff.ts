/**
 * Handing a script from one screen to the editor: Ideas puts it here, the
 * editor takes it once and removes it. Session storage, so it never
 * outlives the tab and never reaches the server.
 */
export const scriptKey = (projectId: string): string => `studio.script.${projectId}`;
