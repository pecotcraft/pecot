/**
OOXML の名前空間・リレーションシップ種別の URI。

ECMA-376 は識別子を `http:` で定める。XML の名前空間比較は文字列の一致で行われる。
`https:` にすると別の名前空間になり、PPTX / XLSX が正しく読めなくなる。
*/
export const NS_DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main'
export const NS_PRESENTATIONML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const NS_SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const NS_SPREADSHEET_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
export const NS_OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const NS_MARKUP_COMPATIBILITY = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
export const NS_PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
export const NS_POWERPOINT_2010 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
export const NS_POWERPOINT_2015_09 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main'

export const REL_TYPE_SLIDE = `${NS_OFFICE_RELATIONSHIPS}/slide`
export const REL_TYPE_FONT = `${NS_OFFICE_RELATIONSHIPS}/font`
export const REL_TYPE_HYPERLINK = `${NS_OFFICE_RELATIONSHIPS}/hyperlink`
