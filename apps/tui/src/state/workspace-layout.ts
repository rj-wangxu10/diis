export const RIGHT_PANEL_MIN_WIDTH = 320;
export const RIGHT_PANEL_MAX_WIDTH = 640;
export const RIGHT_PANEL_DEFAULT_WIDTH = 400;
export const CHAT_MIN_WIDTH = 420;
export const CHAT_CONTENT_MIN_WIDTH = 360;
export const CHAT_CONTENT_MAX_WIDTH = 760;
export const CHAT_INPUT_PREFERRED_WIDTH = CHAT_CONTENT_MAX_WIDTH;
export const CHAT_INPUT_MIN_WIDTH = 360;
export const CHAT_INPUT_HORIZONTAL_PADDING = 32;
export const LEFT_PANEL_MIN_WIDTH = 200;
export const LEFT_PANEL_MAX_WIDTH = 280;
export const LEFT_PANEL_DEFAULT_WIDTH = 260;
export const LEFT_PANEL_WIDTH_EXPANDED = LEFT_PANEL_DEFAULT_WIDTH;
export const LEFT_PANEL_WIDTH_COLLAPSED = 56;

export function clampRightPanelWidth(width: number): number {
  return Math.max(RIGHT_PANEL_MIN_WIDTH, width);
}

export function getChatInputReservedWidth(): number {
  return CHAT_INPUT_PREFERRED_WIDTH + CHAT_INPUT_HORIZONTAL_PADDING;
}

export function fixedGridColumn(width: number): string {
  return `minmax(${width}px, ${width}px)`;
}

export function clampLeftPanelWidth(width: number): number {
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(width, LEFT_PANEL_MAX_WIDTH));
}

export function getLeftPanelWidth(
  sidebarCollapsed: boolean,
  leftPanelWidth: number = LEFT_PANEL_DEFAULT_WIDTH,
): number {
  return sidebarCollapsed ? LEFT_PANEL_WIDTH_COLLAPSED : clampLeftPanelWidth(leftPanelWidth);
}

export function getRequiredWorkspaceWidth({
  sidebarCollapsed,
  rightPanelOpen,
  rightPanelWidth,
  leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH,
}: {
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  leftPanelWidth?: number;
}): number {
  const left = getLeftPanelWidth(sidebarCollapsed, leftPanelWidth);
  const right = rightPanelOpen ? rightPanelWidth : 0;
  return left + right + getChatInputReservedWidth();
}

export function getMinimumWorkspaceWidth({
  sidebarCollapsed,
  rightPanelOpen,
  rightPanelWidth,
  leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH,
}: {
  sidebarCollapsed: boolean;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  leftPanelWidth?: number;
}): number {
  const left = getLeftPanelWidth(sidebarCollapsed, leftPanelWidth);
  const right = rightPanelOpen ? rightPanelWidth : 0;
  return left + right + CHAT_MIN_WIDTH;
}

export function getWorkspaceGridTemplateColumns({
  isConfigPanelOpen,
  isRightPanelOpen,
  sidebarCollapsed,
  rightPanelWidth = RIGHT_PANEL_DEFAULT_WIDTH,
  leftPanelWidth = LEFT_PANEL_DEFAULT_WIDTH,
}: {
  isConfigPanelOpen: boolean;
  isRightPanelOpen: boolean;
  sidebarCollapsed: boolean;
  rightPanelWidth?: number;
  leftPanelWidth?: number;
}): string {
  const left = getLeftPanelWidth(sidebarCollapsed, leftPanelWidth);
  const leftColumn = fixedGridColumn(left);
  const rightColumn = isRightPanelOpen ? fixedGridColumn(rightPanelWidth) : "0fr";
  const configColumn = isConfigPanelOpen ? fixedGridColumn(360) : "0fr";
  return [leftColumn, "1fr", configColumn, rightColumn].join(" ");
}
