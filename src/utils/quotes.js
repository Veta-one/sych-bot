const MarkdownIt = require('markdown-it');
const { parseDocument } = require('htmlparser2');

const markdown = new MarkdownIt({ html: true, breaks: true });

// Work on actual tags, never on escaped text or examples inside code blocks.
function collapseHtmlQuotes(html) {
  const source = String(html);
  const document = parseDocument(source, { withStartIndices: true, withEndIndices: true });
  const edits = [];
  function visit(node, hidden = false) {
    if (['code', 'pre', 'script', 'style'].includes(node.name)) return;
    if (node.name === 'details' && !Object.hasOwn(node.attribs, 'open')) hidden = true;
    if (node.name === 'blockquote') {
      const end = source.indexOf('>', node.startIndex) + 1;
      const opening = source.slice(node.startIndex, end)
        .replace(/\s+expandable(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
      edits.push({ start: node.startIndex, end, text: hidden ? opening : opening.replace(/>$/, ' expandable>') });
      hidden = true; // A nested quote must not require another click.
    }
    for (const child of node.children || []) visit(child, hidden);
  }
  visit(document);
  return edits.sort((a, b) => b.start - a.start).reduce(
    (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

// Render only blocks containing quotations. All other rich Markdown (including
// Telegram extensions) remains untouched. Token maps protect fenced/inline code,
// lazy quote continuations and quotes nested in lists.
function collapseMarkdownQuotes(source) {
  const text = String(source);
  const lines = text.split('\n');
  const tokens = markdown.parse(text, {});
  const edits = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.level !== 0 || !token.map) continue;
    let end = i;
    if (token.nesting === 1) {
      while (end + 1 < tokens.length && !(tokens[end + 1].level === 0 && tokens[end + 1].nesting === -1)) end++;
      end = Math.min(end + 1, tokens.length - 1);
    }
    const block = lines.slice(...token.map).join('\n');
    if (tokens.slice(i, end + 1).some(t => t.type === 'blockquote_open')) {
      edits.push({ start: token.map[0], end: token.map[1], text: collapseHtmlQuotes(markdown.render(block)).trimEnd() });
    } else if (token.type === 'html_block') {
      edits.push({ start: token.map[0], end: token.map[1], text: collapseHtmlQuotes(block) });
    }
    i = end;
  }
  for (const edit of edits.reverse()) lines.splice(edit.start, edit.end - edit.start, edit.text);
  // HTML disclosures can span several Markdown blocks. Normalize once more
  // with their full scope, protecting code that must remain literal.
  const result = lines.join('\n');
  const resultLines = result.split('\n');
  let marker = 'SYCH_LITERAL_';
  while (result.includes(marker)) marker += '_';
  const literals = [];
  const protect = value => `${marker}${literals.push(value) - 1}_END`;
  const codeBlocks = markdown.parse(result, {}).filter(t => t.map && ['fence', 'code_block'].includes(t.type));
  for (const token of codeBlocks.reverse()) {
    resultLines.splice(token.map[0], token.map[1] - token.map[0], protect(resultLines.slice(...token.map).join('\n')));
  }
  const masked = resultLines.join('\n').replace(/(`+)([\s\S]*?)\1(?!`)/g, protect);
  return collapseHtmlQuotes(masked).replace(new RegExp(`${marker}(\\d+)_END`, 'g'), (_, index) => literals[Number(index)]);
}

// Legacy sendMessage has no <details>. Keep the transcript behind one native
// expandable quote instead, using UTF-16 entity offsets and lossless chunking.
function quoteFallback(content) {
  const html = content.html != null ? content.html : markdown.render(content.markdown || '');
  const document = parseDocument(html);
  let text = '';
  const entities = [];
  const newline = () => { if (text && !text.endsWith('\n')) text += '\n'; };
  function visit(node, inQuote = false) {
    if (node.type === 'text') { text += node.data; return; }
    if (['script', 'style'].includes(node.name)) return;
    const block = /^(p|div|li|h[1-6]|blockquote|pre|details|summary|tr|ul|ol)$/.test(node.name || '');
    if (block) newline();
    if (node.name === 'br') { text += '\n'; return; }
    if (node.name === 'li') text += '• ';
    const start = text.length;
    const quoted = node.name === 'blockquote';
    for (const child of node.children || []) visit(child, inQuote || quoted);
    if (quoted && !inQuote) {
      const length = text.slice(start).trimEnd().length;
      if (length) entities.push({ type: 'expandable_blockquote', offset: start, length });
    }
    if (block) newline();
  }
  visit(document);
  if (!entities.length) return null;
  text = text.trimEnd();
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const chunkEntities = entities.flatMap(entity => {
      const from = Math.max(start, entity.offset);
      const to = Math.min(end, entity.offset + entity.length);
      return to > from ? [{ type: entity.type, offset: from - start, length: to - from }] : [];
    });
    chunks.push({ text: text.slice(start, end), entities: chunkEntities });
    start = end;
  }
  return chunks;
}

module.exports = { collapseHtmlQuotes, collapseMarkdownQuotes, quoteFallback };
