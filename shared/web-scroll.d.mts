export type ScrollAnchor = { id: number; containerId: number; fraction: number; before: number; ratio: number; left: number };
export function readScrollAnchor(container: Element, mirror: { getId(node: Node): number }, containerId?: number): ScrollAnchor;
