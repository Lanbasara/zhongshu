/** Streaming JSON syntax/envelope validation; body strings are never accumulated. */
type Frame = { kind: 'object' | 'array'; stage: string; path: string; key?: string; index: number; start: number; textBlock?: { type: boolean; nonempty: boolean }; hasText?: boolean };
const envelopeFields = ['/type', '/seq', '/time', '/data/turn', '/data/step', '/data/callId', '/data/name', '/data/message/toolCallId', '/data/toolCall/callId', '/data/source/rpcId', '/data/kind', '/data/producerReported', '/data/outcome', '/data/reason/kind'];
export type JsonEnvelopeEvents = { string(path: string, text: string, final: boolean): void; value(path: string, value: unknown): void; end(path: string): void; span(path: string, start: number, end: number): void };
export type JsonSelection = { capture(path: string): boolean; stream(path: string): boolean };
export class BoundedJsonEnvelope {
  private stack: Frame[] = [];
  private root = false;
  private token: 'string' | 'scalar' | undefined;
  private value = '';
  private key = false;
  private capture = false;
  private escaped = false;
  private unicode = 0;
  private tokenPath = '';
  private tokenStart = 0;
  private offset = 0;
  private stream = false;
  private decoded = '';
  private escapeDigits = '';
  private stringNonempty = false;
  private messageText = false;
  private readonly events?: JsonEnvelopeEvents;
  private selection?: JsonSelection;
  constructor(events?: JsonEnvelopeEvents, selection?: JsonSelection) { this.events = events; this.selection = selection; }
  readonly fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  /** native.textContent concatenates text blocks without separators. Keep only
   * presence, even when text precedes type or a body spans many input chunks. */
  get hasMessageText(): boolean { return this.messageText; }

  private fail(): never { throw new Error('dsh_bounded_invalid_json'); }
  private path(): string {
    const frame = this.stack.at(-1);
    return frame ? frame.kind === 'object' ? `${frame.path}/${frame.key!.replaceAll('~', '~0').replaceAll('/', '~1')}` : `${frame.path}/${frame.index}` : '';
  }
  private done(value?: unknown): void {
    if (this.capture && (this.selection ? this.selection.capture(this.tokenPath) : envelopeFields.includes(this.tokenPath))) this.fields[this.tokenPath] = value;
    const frame = this.stack.at(-1);
    if (!frame) { if (this.root) this.fail(); this.root = true; }
    else if (frame.stage !== 'value') this.fail();
    else { frame.stage = 'comma'; if (frame.kind === 'array') frame.index++; }
    this.capture = false;
  }
  private valueAllowed(): void {
    const frame = this.stack.at(-1);
    if (frame ? frame.stage !== 'value' : this.root) this.fail();
  }
  write(text: string): void {
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      const code = char.charCodeAt(0), previousOffset = this.offset;
      this.offset += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : code >= 0xdc00 && code <= 0xdfff ? 0 : 3;
      if (this.token === 'string') {
        if (this.capture || this.key) {
          this.value += char;
          if (this.value.length > 8192) throw new Error('dsh_bounded_metadata_too_large');
        }
        if (this.unicode) { if (!/[0-9a-fA-F]/.test(char)) this.fail(); this.escapeDigits += char; this.unicode--; if (!this.unicode && this.stream) { this.decoded += String.fromCharCode(parseInt(this.escapeDigits, 16)); this.flush(false); } continue; }
        if (this.escaped) { this.escaped = false; if (char === 'u') { this.unicode = 4; this.escapeDigits = ''; } else if (!'"\\/bfnrt'.includes(char)) this.fail(); else if (this.stream) { this.decoded += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] ?? char; this.flush(false); } continue; }
        if (char === '\\') { this.stringNonempty = true; this.escaped = true; continue; }
        if (char.charCodeAt(0) < 32) this.fail();
        if (char !== '"') { this.stringNonempty = true; if (this.stream) { this.decoded += char; this.flush(false); } continue; }
        this.token = undefined;
        if (this.key) {
          const frame = this.stack.at(-1)!;
          frame.key = JSON.parse(this.value) as string; frame.stage = 'colon';
        } else {
          if (this.stream) this.flush(true);
          const value: unknown = this.capture ? JSON.parse(this.value) : undefined;
          const frame = this.stack.at(-1);
          if (frame?.textBlock) {
            if (frame.key === 'type') frame.textBlock.type = value === 'text';
            if (frame.key === 'text') frame.textBlock.nonempty = this.stringNonempty;
          }
          if (this.capture) this.events?.value(this.tokenPath, value);
          this.events?.span(this.tokenPath, this.tokenStart, this.offset); this.done(value);
        }
        this.stream = false;
        this.value = ''; continue;
      }
      if (this.token === 'scalar') {
        if (!/[\s,\]}]/.test(char)) {
          this.value += char; if (this.value.length > 128) this.fail(); continue;
        }
        this.offset = previousOffset; this.finishScalar(); index--; continue;
      }
      if (/\s/.test(char)) { if (!' \r\n\t'.includes(char)) this.fail(); continue; }
      const frame = this.stack.at(-1);
      if (char === '}' || char === ']') {
        if (!frame || (char === '}' ? frame.kind !== 'object' : frame.kind !== 'array')) this.fail();
        if (!['empty', 'comma'].includes(frame.stage)) this.fail();
        this.stack.pop();
        if (frame.textBlock?.type && frame.textBlock.nonempty) this.stack.at(-1)!.hasText = true;
        if (frame.kind === 'array' && frame.path === '/data/message/content') this.messageText = frame.hasText === true;
        this.events?.end(frame.path); this.events?.span(frame.path, frame.start, this.offset); this.capture = false; this.done(); continue;
      }
      if (frame?.stage === 'comma') {
        if (char !== ',') this.fail(); frame.stage = frame.kind === 'object' ? 'key' : 'value'; continue;
      }
      if (frame?.stage === 'colon') { if (char !== ':') this.fail(); frame.stage = 'value'; continue; }
      if (frame?.kind === 'object' && ['empty', 'key'].includes(frame.stage)) {
        if (char !== '"') this.fail(); this.token = 'string'; this.key = true; this.capture = false; this.value = '"'; continue;
      }
      if (frame?.kind === 'array' && frame.stage === 'empty') frame.stage = 'value';
      this.valueAllowed(); this.key = false; this.tokenPath = this.path();
      // Resets also follow JSON's last-property-wins behavior. Non-string text
      // and non-array content never become visible assistant text.
      if (['/data', '/data/message', '/data/message/content'].includes(this.tokenPath)) this.messageText = false;
      if (frame?.textBlock) {
        if (frame.key === 'type') frame.textBlock.type = false;
        if (frame.key === 'text') frame.textBlock.nonempty = false;
      }
      this.tokenStart = previousOffset;
      this.capture = envelopeFields.includes(this.tokenPath) || !!this.events && (/^\/data\/(step|callId|name|interrupted|kind|producerReported|detail|outcome)$/.test(this.tokenPath) || /^\/data\/(source\/rpcId|message\/(toolCallId|isError)|reason\/kind|toolCall\/callId|meta\/(path|operation))$/.test(this.tokenPath) || /^\/data\/(?:message\/)?content\/\d+\/type$/.test(this.tokenPath));
      this.stream = !!this.events && (/^\/data\/(?:message\/)?content\/\d+\/text$/.test(this.tokenPath) || /^\/data\/(input|arguments)$/.test(this.tokenPath));
      if (this.selection) { this.capture = this.selection.capture(this.tokenPath); this.stream = !!this.events && this.selection.stream(this.tokenPath); }
      if (frame?.textBlock && frame.key === 'type') this.capture = true;
      if (char === '{' || char === '[') {
        if (this.stack.length >= 128) throw new Error('dsh_bounded_json_depth');
        const textBlock = char === '{' && frame?.kind === 'array' && frame.path === '/data/message/content' ? { type: false, nonempty: false } : undefined;
        this.stack.push({ kind: char === '{' ? 'object' : 'array', stage: 'empty', path: this.tokenPath, index: 0, start: previousOffset, ...(textBlock ? { textBlock } : {}) }); this.capture = false; this.stream = false;
      } else if (char === '"') { this.token = 'string'; this.stringNonempty = false; this.value = this.capture ? '"' : ''; }
      else { this.token = 'scalar'; this.value = char; }
    }
  }
  private finishScalar(): void {
    if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.value)) this.fail();
    const value: unknown = JSON.parse(this.value); this.token = undefined; this.value = ''; if (this.capture || /^\/data\/(input|arguments)$/.test(this.tokenPath)) this.events?.value(this.tokenPath, value); this.events?.span(this.tokenPath, this.tokenStart, this.offset); this.done(value);
  }
  private flush(final: boolean): void {
    if (!final && this.decoded.length < 8192) return;
    let end = this.decoded.length;
    if (!final && end && /[\ud800-\udbff]/.test(this.decoded[end - 1]!)) end--;
    if (end || final) this.events?.string(this.tokenPath, this.decoded.slice(0, end), final);
    this.decoded = this.decoded.slice(end);
  }
  finishDocument(): void {
    if (this.token === 'scalar') this.finishScalar();
    if (this.token || this.stack.length || !this.root) this.fail();
  }
  finish(): { type: string; seq: number; time: number; turn?: number; callId?: string; toolName?: string } {
    this.finishDocument();
    const type = this.fields['/type'], seq = this.fields['/seq'], time = this.fields['/time'], rawTurn = this.fields['/data/turn'];
    // rc.4 manual compaction can run while no execution turn is open. Its
    // start/end records explicitly encode that owner as null. This is not a
    // turn/start and must not relax the integer requirement for other events.
    const turn = rawTurn === null && (type === 'compaction/start' || type === 'compaction/end') ? undefined : rawTurn;
    if (typeof type !== 'string' || !type || type.length > 256 || !Number.isSafeInteger(seq) || Number(seq) < 0 || !Number.isSafeInteger(time) || Number(time) < 0) this.fail();
    if (turn !== undefined && (!Number.isSafeInteger(turn) || Number(turn) < 0)) this.fail();
    const callId = this.fields['/data/callId'] ?? this.fields['/data/message/toolCallId'] ?? this.fields['/data/toolCall/callId'], name = this.fields['/data/name'];
    return { type, seq: Number(seq), time: Number(time), ...(turn === undefined ? {} : { turn: Number(turn) }), ...(typeof callId === 'string' && callId.length <= 512 ? { callId } : {}), ...(typeof name === 'string' ? { toolName: name.slice(0, 200) } : {}) };
  }
}
