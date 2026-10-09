export type ReadingPosition = { domId:string; tag:string; text:string; fraction:number; before:number; ratio:number; left:number };
export type SavedReading = { version:1; url:string; language:string; mode:'desktop'|'adaptive'; fit:boolean; zoom:number; position:ReadingPosition|null; panX:number };
export const READING_KEY: string;
export function parseReading(raw:string|null): SavedReading|null;
export function viewportLayout(options:{paneWidth:number;paneHeight:number;mode:'desktop'|'adaptive';zoom:number;fit:boolean}): {width:number;height:number;scale:number};
