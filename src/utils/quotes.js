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

// Legacy sendMessage has no <details>. Keep closed bodies behind one native
// expandable quote and open bodies visible, with clickable UTF-16 link entities.
function quoteFallback(content) {
  const html = content.html != null ? content.html : markdown.render(content.markdown || '');
  const document = parseDocument(html);
  let text = '';
  let hasDisclosure = false;
  const entities = [];
  const newline = () => { if (text && !text.endsWith('\n')) text += '\n'; };
  function expandable(start) {
    const length = text.slice(start).trimEnd().length;
    if (length) entities.push({ type: 'expandable_blockquote', offset: start, length });
  }
  function visit(node, inQuote = false) {
    if (node.type === 'text') { text += node.data; return; }
    if (['script', 'style'].includes(node.name)) return;
    if (node.name === 'details') {
      hasDisclosure = true;
      newline();
      const summary = node.children.find(child => child.name === 'summary');
      if (summary) visit(summary, inQuote);
      const start = text.length;
      for (const child of node.children) {
        if (child !== summary) visit(child, true);
      }
      if (!inQuote && !Object.hasOwn(node.attribs, 'open')) expandable(start);
      newline();
      return;
    }
    const block = /^(p|div|li|h[1-6]|blockquote|pre|summary|tr|ul|ol)$/.test(node.name || '');
    if (block) newline();
    if (node.name === 'br') { text += '\n'; return; }
    if (node.name === 'li') text += '• ';
    const start = text.length;
    const quoted = node.name === 'blockquote';
    for (const child of node.children || []) visit(child, inQuote || quoted);
    if (node.name === 'a' && text.length > start) {
      try {
        const url = new URL(node.attribs?.href);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
          entities.push({ type: 'text_link', offset: start, length: text.length - start, url: url.href });
        }
      } catch { /* An invalid destination stays plain text. */ }
    }
    if (quoted && !inQuote) expandable(start);
    if (block) newline();
  }
  visit(document);
  if (!hasDisclosure && !entities.some(entity => entity.type === 'expandable_blockquote')) return null;
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  text = text.trimEnd();
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const chunkEntities = entities.flatMap(entity => {
      const from = Math.max(start, entity.offset);
      const to = Math.min(end, entity.offset + entity.length);
      return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
    });
    chunks.push({ text: text.slice(start, end), entities: chunkEntities });
    start = end;
  }
  return chunks;
}

function stripImageMarkup(text, { markdownImages = true } = {}) {
  if (!/!\[|<(?:\/?tg-(?:collage|slideshow)|img)\b/i.test(text)) return text;
  const strip = value => {
    const plain = value.replace(/<\/?tg-(?:collage|slideshow)\b[^>]*>|<img\b[^>]*>/gi, '')
      .replace(/<(?=\/?tg-(?:collage|slideshow)\b|img\b)/gi, '&lt;');
    return markdownImages ? plain.replace(/!\[[^\]]*\](?:\([^\n]*?\)|\[[^\]\n]*\])?/g, '').replace(/!\[/g, '[') : plain;
  };
  const stripInline = value => {
    let out = '', end = 0;
    for (const match of value.matchAll(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      out += strip(value.slice(end, match.index)) + match[0];
      end = match.index + match[0].length;
    }
    return out + strip(value.slice(end));
  };
  const lines = text.split('\n');
  const codeBlocks = markdown.parse(text, {}).filter(token => token.type === 'fence' || token.type === 'code_block');
  const chunks = [];
  let cursor = 0;
  for (const { map: [start, end] } of codeBlocks) {
    if (start > cursor) chunks.push(stripInline(lines.slice(cursor, start).join('\n')));
    chunks.push(lines.slice(start, end).join('\n'));
    cursor = end;
  }
  if (cursor < lines.length) chunks.push(stripInline(lines.slice(cursor).join('\n')));
  return chunks.join('\n');
}

module.exports = { collapseHtmlQuotes, collapseMarkdownQuotes, quoteFallback, stripImageMarkup };
