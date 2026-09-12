import { sanitizePersistedDiagram, type Diagram } from './domain/types';

/**
 * Client-side Share codec. No backend: the diagram travels in the URL hash.
 *
 * Hash format: `#s` + version char + base64url payload.
 * - version `1`: JSON payload compressed with deflate-raw (native
 *   CompressionStream — no dependency).
 * - version `0`: uncompressed JSON fallback for browsers without
 *   CompressionStream. The decoder always accepts both.
 *
 * Only diagram content is serialized (nodes, names, values, positions,
 * connections, connection values, diagram id/name). History, selection,
 * UI state, and preferences never enter the URL.
 */

export const SHARE_HASH_PREFIX = '#s';

interface SharedNode {
  i: string;
  l: string;
  v: number;
  c?: string;
  t: number;
  p: [number, number];
}

interface SharedConn {
  i: string;
  s: string;
  t: string;
  v: number;
  l?: string;
  c: number;
}

interface SharedPayload {
  v: 1;
  id: string;
  n: string;
  nodes: SharedNode[];
  conns: SharedConn[];
}

export function isShareHash(hash: string): boolean {
  return (
    typeof hash === 'string' &&
    hash.startsWith(SHARE_HASH_PREFIX) &&
    hash.length > SHARE_HASH_PREFIX.length + 1
  );
}

/**
 * Build a self-contained sub-diagram from a selection, using the same
 * Diagram shape (and therefore the same serialization, compression, and
 * validation) as whole-diagram sharing. No second format.
 *
 * - Selected nodes are included.
 * - Connections between selected nodes are included even when the ribbon
 *   itself was not explicitly selected.
 * - A selected ribbon pulls in its endpoint nodes automatically.
 * - Everything else from the original canvas is left out, so the recipient
 *   never needs the original diagram.
 * - Returns null when the selection matches nothing on the canvas.
 */
export function extractSelectedSubdiagram(
  diagram: Diagram,
  selectedNodeIds: Iterable<string>,
  selectedConnectionIds: Iterable<string>,
): Diagram | null {
  const existingNodes = new Set(diagram.nodes.map((n) => n.id));
  const nodeIds = new Set<string>();
  for (const id of selectedNodeIds) {
    if (existingNodes.has(id)) nodeIds.add(id);
  }
  const existingConns = new Set(diagram.connections.map((c) => c.id));
  const selectedConns = new Set<string>();
  for (const id of selectedConnectionIds) {
    if (existingConns.has(id)) selectedConns.add(id);
  }
  const connections = diagram.connections.filter(
    (c) =>
      selectedConns.has(c.id) ||
      (nodeIds.has(c.sourceId) && nodeIds.has(c.targetId)),
  );
  // Endpoints of an explicitly selected ribbon come along automatically.
  for (const c of connections) {
    if (existingNodes.has(c.sourceId)) nodeIds.add(c.sourceId);
    if (existingNodes.has(c.targetId)) nodeIds.add(c.targetId);
  }
  const nodes = diagram.nodes.filter((n) => nodeIds.has(n.id));
  if (nodes.length === 0) return null;
  const keptConns = connections.filter(
    (c) => nodeIds.has(c.sourceId) && nodeIds.has(c.targetId),
  );
  return {
    id: diagram.id,
    name: diagram.name,
    nodes: nodes.map((n) => ({ ...n })),
    connections: keptConns.map((c) => ({ ...c })),
    positions: Object.fromEntries(
      nodes.map((n) => [n.id, { ...(diagram.positions[n.id] ?? { x: 100, y: 100 }) }]),
    ),
    updatedAt: Date.now(),
  };
}

/** Consume the share hash so a refresh keeps the local diagram, not the link. */
export function clearShareHash(): void {
  try {
    if (window.location.hash.startsWith(SHARE_HASH_PREFIX)) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch {
    // Restricted context — harmless, the hash simply stays.
  }
}

function toPayload(diagram: Diagram): SharedPayload {
  return {
    v: 1,
    id: diagram.id,
    n: diagram.name,
    nodes: diagram.nodes.map((node) => ({
      i: node.id,
      l: node.label,
      v: node.value,
      ...(node.color ? { c: node.color } : {}),
      t: node.createdAt,
      p: [diagram.positions[node.id]?.x ?? 100, diagram.positions[node.id]?.y ?? 100],
    })),
    conns: diagram.connections.map((c) => ({
      i: c.id,
      s: c.sourceId,
      t: c.targetId,
      v: c.value,
      ...(c.label ? { l: c.label } : {}),
      c: c.createdAt,
    })),
  };
}

function streamCtor(
  name: 'CompressionStream' | 'DecompressionStream',
): (new (format: string) => { writable: WritableStream; readable: ReadableStream }) | null {
  const ctor = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof ctor === 'function'
    ? (ctor as new (format: string) => { writable: WritableStream; readable: ReadableStream })
    : null;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const CS = streamCtor('CompressionStream');
  if (!CS) throw new Error('no CompressionStream');
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new CS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const DS = streamCtor('DecompressionStream');
  if (!DS) throw new Error('no DecompressionStream');
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encodeDiagramToHash(diagram: Diagram): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(toPayload(diagram)));
  try {
    return `${SHARE_HASH_PREFIX}1${bytesToBase64Url(await deflateRaw(raw))}`;
  } catch {
    return `${SHARE_HASH_PREFIX}0${bytesToBase64Url(raw)}`;
  }
}

function isSharedPayload(raw: unknown): raw is SharedPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;
  return p.v === 1 && typeof p.id === 'string' && Array.isArray(p.nodes) && Array.isArray(p.conns);
}

/**
 * Decode a share hash into a sanitized Diagram, or null when missing,
 * malformed, or unrecoverable. Reuses the persisted-state sanitizer so
 * shared links get exactly the same repair rules as localStorage data.
 */
export async function decodeSharedDiagram(hash: string): Promise<Diagram | null> {
  try {
    if (!isShareHash(hash)) return null;
    const version = hash[SHARE_HASH_PREFIX.length];
    const bytes = base64UrlToBytes(hash.slice(SHARE_HASH_PREFIX.length + 1));
    const raw =
      version === '1' ? await inflateRaw(bytes) : version === '0' ? bytes : null;
    if (!raw) return null;
    const payload: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!isSharedPayload(payload)) return null;
    return sanitizePersistedDiagram({
      id: payload.id,
      name: typeof payload.n === 'string' ? payload.n : 'Untitled flow',
      nodes: payload.nodes.map((n) => ({
        id: n.i,
        label: n.l,
        value: n.v,
        color: n.c,
        createdAt: n.t,
      })),
      connections: payload.conns.map((c) => ({
        id: c.i,
        sourceId: c.s,
        targetId: c.t,
        value: c.v,
        label: c.l,
        createdAt: c.c,
      })),
      positions: Object.fromEntries(payload.nodes.map((n) => [n.i, { x: n.p[0], y: n.p[1] }])),
      updatedAt: Date.now(),
    });
  } catch {
    return null;
  }
}

export async function buildShareUrl(diagram: Diagram): Promise<string> {
  return `${window.location.href.split('#')[0]}${await encodeDiagramToHash(diagram)}`;
}

/** Clipboard write with a legacy fallback; rejects when neither works. */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Non-secure context or denied permission — try the legacy path.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed');
  } finally {
    area.remove();
  }
}
