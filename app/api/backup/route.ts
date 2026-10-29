import { join } from 'node:path';
import { createPortableBackup, MAX_BACKUP_BYTES, restoreToSeparateDatabase } from '../../../lib/backup.ts';
import { localDateKey } from '../../../lib/dates.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
function activePath() { return process.env.PAINEL_DB_PATH || join(process.cwd(), 'data', 'painel.sqlite'); }
function requestError(request: Request, expectedType?: string): Response | undefined {
 const origin = request.headers.get('origin');
 if (!origin) return Response.json({ error: 'A origem da solicitação não foi informada.' }, { status: 403, headers: noStore });
 try {
  const parsed = new URL(origin);
  const target = new URL(request.url);
  const host = request.headers.get('host') || target.host;
  if (parsed.origin !== `${target.protocol}//${host}`) return Response.json({ error: 'Origem da solicitação não permitida.' }, { status: 403, headers: noStore });
 } catch { return Response.json({ error: 'Origem da solicitação inválida.' }, { status: 403, headers: noStore }); }
 if (expectedType && !new RegExp(`^${expectedType}(?:\\s*;|\\s*$)`, 'i').test(request.headers.get('content-type') || '')) {
  return Response.json({ error: 'Formato de envio inválido.' }, { status: 415, headers: noStore });
 }
 return undefined;
}
function bodySize(request: Request): number | undefined {
 const length = Number(request.headers.get('content-length'));
 return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}
function friendly(error: unknown): string {
 if (error instanceof Error && /sqlite|database disk image|file is not a database|malformed|no such table|no such column/i.test(error.message)) return 'O banco ou arquivo está danificado ou não é compatível com o Koema.';
 return error instanceof Error ? error.message : 'Não foi possível concluir a operação de backup.';
}

async function exportBackup() {
 try {
  const result = await createPortableBackup(activePath());
  const filename = `koema-backup-${localDateKey(result.info.createdAt)}.sqlite`;
  return new Response(new Uint8Array(result.bytes), { headers: { ...noStore, 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Koema-Backup-Info': encodeURIComponent(JSON.stringify(result.info)) } });
 } catch (error) { return Response.json({ error: friendly(error) }, { status: 500, headers: noStore }); }
}

export async function POST(request: Request) {
 const invalid = requestError(request);
 if (invalid) return invalid;
 const contentType = request.headers.get('content-type') || '';
 if (/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
  const declaredSize = bodySize(request);
  if (declaredSize !== undefined && declaredSize > 1024) return Response.json({ error: 'Solicitação de exportação inválida.' }, { status: 400, headers: noStore });
  try { await limitedRequest(request, 1024).then(body => body.json()); } catch { return Response.json({ error: 'Solicitação de exportação inválida.' }, { status: 400, headers: noStore }); }
  return exportBackup();
 }
 if (!/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) return Response.json({ error: 'Envie um arquivo de backup no formato multipart.' }, { status: 415, headers: noStore });
 const declaredSize = bodySize(request);
 if (declaredSize !== undefined && declaredSize > MAX_BACKUP_BYTES + 256 * 1024) return Response.json({ error: 'O arquivo ultrapassa o limite de 64 MB.' }, { status: 413, headers: noStore });
 try {
  const form = await limitedRequest(request, MAX_BACKUP_BYTES + 256 * 1024).then(body => body.formData());
  const file = form.get('backup');
  if (!(file instanceof File)) return Response.json({ error: 'Selecione um arquivo de backup do Koema.' }, { status: 400, headers: noStore });
  if (file.size > MAX_BACKUP_BYTES) return Response.json({ error: 'O arquivo ultrapassa o limite de 64 MB.' }, { status: 413, headers: noStore });
  if (file.size === 0) return Response.json({ error: 'O arquivo está vazio.' }, { status: 400, headers: noStore });
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await restoreToSeparateDatabase(bytes, activePath());
  return Response.json({ status: 'verified', ...result, message: 'O backup foi verificado e salvo como banco separado. O banco ativo continua inalterado.' }, { headers: noStore });
 } catch (error) {
  const message = friendly(error);
  const status = /64 MB|limite/i.test(message) ? 413 : error instanceof TypeError || error instanceof SyntaxError || /danificado|não é|não passou|não contém|versão|inválid|correspondem|reconhece|esquema|referências/i.test(message) ? 400 : 500;
  return Response.json({ error: message }, { status, headers: noStore });
 }
}

async function limitedRequest(request: Request, maxBytes: number): Promise<Request> {
 if (!request.body) throw new Error('O corpo do envio está vazio.');
 const reader = request.body.getReader();
 let received = 0;
 const body = new ReadableStream<Uint8Array>({
  async pull(controller) {
   const chunk = await reader.read();
   if (chunk.done) { controller.close(); return; }
   received += chunk.value.byteLength;
   if (received > maxBytes) { await reader.cancel(); controller.error(new Error('O arquivo ultrapassa o limite de 64 MB.')); return; }
   controller.enqueue(chunk.value);
  },
  cancel(reason) { return reader.cancel(reason); },
 });
 return new Request(request.url, { method: 'POST', headers: request.headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
}
