/**
 * A very small, tolerant XML reader — just enough to walk an OVF descriptor.
 *
 * OVF is namespace-heavy (`ovf:`, `rasd:`, `vssd:`, `vmw:`), and which prefix a
 * given exporter picks varies. So prefixes are stripped from both element and
 * attribute names, and lookups are case-insensitive. That's wrong for XML in
 * general and exactly right for reading one well-known schema.
 */

export interface XmlNode {
  /** Element name with any namespace prefix removed. */
  name: string;
  /** Attributes, prefix-stripped, keyed by lowercased name. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, trimmed. */
  text: string;
}

const localName = (raw: string) => {
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(colon + 1);
};

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;

    // Text between the previous tag and this one belongs to the open element.
    if (lt > i) {
      const text = decodeEntities(source.slice(i, lt)).trim();
      if (text) {
        const top = stack[stack.length - 1];
        top.text = top.text ? `${top.text} ${text}` : text;
      }
    }

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      const body = source.slice(lt + 9, end === -1 ? source.length : end);
      const top = stack[stack.length - 1];
      top.text = top.text ? `${top.text} ${body}` : body;
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) break;
    const inner = source.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }

    const node: XmlNode = {
      name: localName(nameMatch[1]),
      attrs: parseAttrs(body.slice(nameMatch[0].length)),
      children: [],
      text: "",
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/** Find the `>` that closes a tag, skipping any inside quoted attribute values. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const key = localName(m[1]).toLowerCase();
    attrs[key] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** Every descendant with the given (prefix-stripped) element name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const wanted = name.toLowerCase();
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (child.name.toLowerCase() === wanted) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

/** Direct children only — used where nesting depth carries meaning. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  const wanted = name.toLowerCase();
  return node.children.filter((c) => c.name.toLowerCase() === wanted);
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  return node?.attrs[name.toLowerCase()];
}

/** Text of the first descendant with this name. */
export function textOf(node: XmlNode, name: string): string | undefined {
  const found = findFirst(node, name);
  return found?.text || undefined;
}
