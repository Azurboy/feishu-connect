import type { DocBlock } from "./feishu";

type Omission = { type: string; reason: "not_supported_in_v0.1" };
type Field = Record<string, unknown>;
const record = (value: unknown): Field => value && typeof value === "object" && !Array.isArray(value) ? value as Field : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function textOf(block: DocBlock, field: string, omitted: (type: string) => string): string {
  const elements = array(record(block[field]).elements);
  return elements.map((element) => {
    const part = record(element);
    const text = record(part.text_run).content;
    if (typeof text === "string") return text;
    if (part.mention_user) return omitted("mention_user");
    if (part.mention_doc) return omitted("mention_doc");
    return omitted("inline_element");
  }).join("");
}

export function renderBlocks(blocks: DocBlock[]): { content: string; omissions: Omission[] } {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const root = blocks.find((block) => block.block_type === 1 && !block.parent_id);
  if (!root) throw new Error("invalid_document_tree");
  const omissions: Omission[] = [];
  const visited = new Set<string>();
  const lines: string[] = [];
  const label = (type: string) => { omissions.push({ type, reason: "not_supported_in_v0.1" }); return `[${type} 未读取]`; };
  const cellText = (id: string, depth: number): string => {
    if (depth > 100 || visited.has(id)) throw new Error("invalid_document_tree");
    const cell = byId.get(id);
    if (!cell) throw new Error("incomplete_document_tree");
    visited.add(id);
    const own = cell.block_type === 2 ? textOf(cell, "text", label) : cell.block_type === 32 ? textOf(cell, "table_cell", label) : label(`block_${cell.block_type}`);
    return [own, ...(cell.children ?? []).map((child) => cellText(child, depth + 1))].filter(Boolean).join(" ").replace(/\|/g, "\\|").replace(/\s+/g, " ");
  };
  const walk = (id: string, depth: number): void => {
    if (depth > 100 || visited.has(id)) throw new Error("invalid_document_tree");
    const block = byId.get(id);
    if (!block) throw new Error("incomplete_document_tree");
    visited.add(id);
    const type = block.block_type;
    if (type === 31) {
      const table = record(block.table);
      const property = record(table.property);
      const cells = array(table.cells).filter((value): value is string => typeof value === "string");
      const rows = Number(property.row_size);
      const columns = Number(property.column_size);
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1 || rows * columns !== cells.length) {
        lines.push(label("table"));
        for (const child of cells) cellText(child, depth + 1);
        return;
      }
      const grid = cells.map((child) => cellText(child, depth + 1));
      const tableLines: string[] = [];
      for (let row = 0; row < rows; row++) {
        tableLines.push(`| ${grid.slice(row * columns, (row + 1) * columns).join(" | ")} |`);
        if (row === 0) tableLines.push(`| ${Array(columns).fill("---").join(" | ")} |`);
      }
      lines.push(tableLines.join("\n"));
      return;
    }
    if (type !== 1) {
      const headings = type >= 3 && type <= 11 ? "#".repeat(type - 2) + " " : "";
      const field = type === 2 ? "text" : type >= 3 && type <= 11 ? `heading${type - 2}` : ({ 12: "bullet", 13: "ordered", 14: "code", 15: "quote", 17: "todo", 32: "table_cell" } as Record<number, string>)[type];
      let line = field ? textOf(block, field, label) : "";
      if ([27, 23, 26, 18, 30, 43, 29, 21, 28, 40, 49, 50, 999].includes(type)) line = label(({ 27: "image", 23: "file", 26: "embed", 18: "bitable", 30: "sheet", 43: "whiteboard" } as Record<number, string>)[type] ?? "embedded_block");
      if (type === 22) line = "---";
      if (!field && !line && type !== 22) line = label(`block_${type}`);
      if (type === 12) line = `- ${line}`;
      if (type === 13) line = `1. ${line}`;
      if (type === 15) line = `> ${line}`;
      if (type === 17) line = `- [ ] ${line}`;
      if (type === 14) line = `\`\`\`\n${line}\n\`\`\``;
      if (line) lines.push(headings + line);
    }
    for (const child of block.children ?? []) walk(child, depth + 1);
  };
  walk(root.block_id, 0);
  if (visited.size !== blocks.length) throw new Error("incomplete_document_tree");
  return { content: lines.join("\n\n"), omissions };
}
