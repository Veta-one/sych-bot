const MarkdownIt = require('markdown-it');
const { parseDocument } = require('htmlparser2');
const { publicUrl } = require('../services/research');

const blocks = new MarkdownIt({ html: true, linkify: false });
const linksMarkdown = new MarkdownIt({ html: false, linkify: true });
const formatting = new Set(['strong_open', 'strong_close', 'em_open', 'em_close', 's_open', 's_close']);
const listBlocks = new Set(['paragraph_open', 'paragraph_close', 'bullet_list_open', 'bullet_list_close',
  'ordered_list_open', 'ordered_list_close', 'list_item_open', 'list_item_close']);

function titleText(value, url) {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim()].slice(0, 180).join('')
    || new URL(url).hostname;
}

function sourceHeading(value) {
  const children = linksMarkdown.parseInline(value, {})[0]?.children || [];
  if (children.some(token => token.type !== 'text' && !formatting.has(token.type))) return false;
  return /^источники\s*:?$/iu.test(children.filter(token => token.type === 'text').map(token => token.content).join('').trim());
}

// Only links and their list/formatting syntax qualify. A single explanatory
// sentence makes the whole appendix ineligible, so audited prose is never cut.
function markdownLinks(body) {
  const links = [];
  const environment = {};
  const tokens = linksMarkdown.parse(body, environment);
  // Removing definitions could break reference citations in the retained prose.
  if (environment.references) return null;
  for (const token of tokens) {
    if (listBlocks.has(token.type)) continue;
    if (token.type !== 'inline') return null;
    let active = null;
    for (const child of token.children || []) {
      if (child.type === 'link_open') {
        if (active) return null;
        const url = publicUrl(child.attrGet('href'));
        if (!url) return null;
        active = { url, title: '' };
      } else if (child.type === 'link_close') {
        if (!active) return null;
        links.push({ url: active.url, title: titleText(active.title, active.url) });
        active = null;
      } else if (formatting.has(child.type)) {
        continue;
      } else if (['softbreak', 'hardbreak'].includes(child.type)) {
        if (active) active.title += ' ';
      } else if (active && ['text', 'code_inline'].includes(child.type)) {
        active.title += child.content;
      } else if (child.type !== 'text' || !/^[\s,;·|.]*$/u.test(child.content)) {
        return null;
      }
    }
    if (active) return null;
  }
  return links.length ? links : null;
}

function htmlLinks(body) {
  const links = [];
  const document = parseDocument(body, { withStartIndices: true, withEndIndices: true });
  function visit(node, active = null) {
    if (node.type === 'text') {
      if (active) active.title += node.data;
      return Boolean(active) || /^\s*$/u.test(node.data);
    }
    if (node.type !== 'root' && node.type !== 'tag') return false;
    if (node.type === 'tag') {
      const attributes = Object.keys(node.attribs || {});
      if (node.name === 'a') {
        if (active || attributes.some(name => name !== 'href' && name !== 'title')) return false;
        const url = publicUrl(node.attribs.href);
        if (!url) return false;
        const link = { url, title: '' };
        if (!body.slice(node.startIndex, node.endIndex + 1).toLowerCase().endsWith('</a>')
          || !node.children.every(child => visit(child, link))) return false;
        links.push({ url, title: titleText(link.title, url) });
        return true;
      }
      if (attributes.length || !(active ? ['strong', 'b', 'em', 'i', 'code'] : ['ol', 'ul', 'li', 'p', 'br']).includes(node.name)) return false;
      if (node.name !== 'br' && !body.slice(node.startIndex, node.endIndex + 1).toLowerCase().endsWith(`</${node.name}>`)) return false;
    }
    return (node.children || []).every(child => visit(child, active));
  }
  return visit(document) && links.length ? links : null;
}

function detailsLinks(body) {
  const match = /^\s*<details(?:\s+open)?\s*>\s*<summary>\s*Источники\s*:?\s*<\/summary>([\s\S]*)<\/details>\s*$/iu.exec(body);
  if (!match) return null;
  return markdownLinks(match[1]) || htmlLinks(match[1]);
}

// Return URL metadata, never trusted markup. The final source renderer remains
// responsible for escaping titles. Call before appending a coverage paragraph:
// a source list followed by prose is deliberately not treated as an appendix.
function splitSourceAppendix(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const lines = text.split('\n');
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const candidates = [];
  for (const token of blocks.parse(text, {})) {
    if (token.level !== 0 || !token.map) continue;
    const [start, end] = token.map;
    if (token.type === 'heading_open') {
      const heading = blocks.parse(lines.slice(start, end).join('\n'), {})[1];
      if (heading?.type === 'inline' && sourceHeading(heading.content)) {
        candidates.push({ start: offsets[start], body: offsets[end], details: false });
      }
    } else if (token.type === 'paragraph_open' && sourceHeading(lines[start].trim())) {
      candidates.push({ start: offsets[start], body: offsets[start + 1], details: false });
    } else if (token.type === 'html_block' && /^\s*<details(?:\s|>)/iu.test(token.content)) {
      candidates.push({ start: offsets[start], body: offsets[start], details: true });
    }
  }
  let end = text.length;
  let collected = [];
  for (const candidate of candidates.reverse()) {
    if (candidate.start >= end) continue;
    const body = text.slice(candidate.body, end);
    const links = candidate.details ? detailsLinks(body) : markdownLinks(body);
    if (links) {
      end = candidate.start;
      collected = links.concat(collected);
    }
  }
  const unique = new Map();
  for (const link of collected) if (!unique.has(link.url)) unique.set(link.url, link);
  return { text: collected.length ? text.slice(0, end).trimEnd() : text, links: [...unique.values()] };
}

module.exports = { splitSourceAppendix };
