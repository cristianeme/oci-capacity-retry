#!/usr/bin/env node
// Crea la VM de TEST en Oracle Cloud reintentando hasta que haya capacidad ARM (A1.Flex Always Free).
// Sin dependencias: firma las llamadas a la API de OCI con la clave de ~/.oci/config (formato estándar de la CLI).
//
//   node deploy/oci-launch.mjs --check     # verifica clave, red, imagen y AD sin crear nada
//   node deploy/oci-launch.mjs             # reintenta cada INTERVAL_SEC (180 por defecto) hasta crearla
//
// Variables opcionales: OCI_CONFIG, OCI_PROFILE, INSTANCE_NAME (sourcinghub-test), INTERVAL_SEC,
// SHAPE (VM.Standard.A1.Flex), SHAPES ("2:12,1:6" = alterna 2 OCPU/12 GB y 1 OCPU/6 GB), SSH_PUBLIC_KEY (ruta),
// CLOUD_INIT (ruta), OCI_KEY_FILE (reemplaza key_file del config).
// Para CI (un intento por corrida): MAX_ATTEMPTS=1, ATTEMPT_OFFSET (n.º de corrida, para alternar tamaños),
// QUIET=1 (no muestra datos de la cuenta), RESULT_FILE (ahí escribe la IP pública cuando la VM existe).
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign, createHash } from 'node:crypto';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();
const expand = (p) => p.replace(/^~(?=$|[\\/])/, home);

// --- Configuración (~/.oci/config)
function readConfig(file, profile) {
  const out = {};
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { current = sec[1]; continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && current === profile) out[kv[1]] = kv[2];
  }
  for (const k of ['user', 'fingerprint', 'tenancy', 'region', 'key_file']) {
    if (!out[k]) throw new Error(`Falta "${k}" en el perfil [${profile}] de ${file}`);
  }
  return out;
}

const cfg = readConfig(expand(process.env.OCI_CONFIG ?? '~/.oci/config'), process.env.OCI_PROFILE ?? 'DEFAULT');
const privateKey = readFileSync(expand(process.env.OCI_KEY_FILE ?? cfg.key_file), 'utf8');
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? Infinity);
const OFFSET = Number(process.env.ATTEMPT_OFFSET ?? 0);
const QUIET = process.env.QUIET === '1';
const done = (ip) => { if (process.env.RESULT_FILE) writeFileSync(process.env.RESULT_FILE, ip); return ip; };
const keyId = `${cfg.tenancy}/${cfg.user}/${cfg.fingerprint}`;
const IAAS = `iaas.${cfg.region}.oraclecloud.com`;
const IDENTITY = `identity.${cfg.region}.oci.oraclecloud.com`;
const COMPARTMENT = cfg.tenancy; // compartimento raíz
const NAME = process.env.INSTANCE_NAME ?? 'sourcinghub-test';
const INTERVAL = Number(process.env.INTERVAL_SEC ?? 180);
const SHAPE = process.env.SHAPE ?? 'VM.Standard.A1.Flex';
const FLEX = SHAPE.endsWith('.Flex');
// Tamaños solo para shapes Flex; las fijas (p. ej. VM.Standard.E2.1.Micro) no llevan shapeConfig.
const SHAPES = FLEX ? (process.env.SHAPES ?? '2:12,1:6').split(',').map((s) => s.split(':').map(Number)) : [[null, null]];
const sshKey = readFileSync(expand(process.env.SSH_PUBLIC_KEY ?? '~/.ssh/oracle_sourcinghub.pub'), 'utf8').trim();
const cloudInit = readFileSync(process.env.CLOUD_INIT ?? join(here, 'cloud-init.yaml'));

// --- Llamada firmada (OCI HTTP Signature, rsa-sha256)
function oci(method, host, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { date: new Date().toUTCString(), host };
  const signed = ['date', '(request-target)', 'host'];
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
    headers['x-content-sha256'] = createHash('sha256').update(payload).digest('base64');
    signed.push('content-length', 'content-type', 'x-content-sha256');
  }
  const signingString = signed
    .map((h) => (h === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${path}` : `${h}: ${headers[h]}`))
    .join('\n');
  const signature = createSign('RSA-SHA256').update(signingString).sign(privateKey, 'base64');
  headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signed.join(' ')}",signature="${signature}"`;

  return new Promise((resolve, reject) => {
    const req = request({ method, host, path, headers, timeout: 60_000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = data ? JSON.parse(data) : undefined; } catch { json = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(Object.assign(new Error(`${res.statusCode} ${json?.code ?? ''}: ${json?.message ?? data}`), { status: res.statusCode, code: json?.code }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const q = (o) => '?' + new URLSearchParams(o).toString();
const log = (...a) => console.log(new Date().toLocaleString('es-AR'), '|', ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// --- Recursos necesarios
async function resolveResources() {
  const ads = await oci('GET', IDENTITY, '/20160918/availabilityDomains' + q({ compartmentId: COMPARTMENT }));
  const subnets = await oci('GET', IAAS, '/20160918/subnets' + q({ compartmentId: COMPARTMENT, lifecycleState: 'AVAILABLE' }));
  const subnet = subnets.find((s) => !s.prohibitPublicIpOnVnic && /public/i.test(s.displayName)) ?? subnets.find((s) => !s.prohibitPublicIpOnVnic);
  if (!subnet) throw new Error('No hay subred pública en el compartimento raíz');
  const images = await oci('GET', IAAS, '/20160918/images' + q({
    compartmentId: COMPARTMENT, operatingSystem: 'Canonical Ubuntu', operatingSystemVersion: '24.04',
    shape: SHAPE, sortBy: 'TIMECREATED', sortOrder: 'DESC', lifecycleState: 'AVAILABLE',
  }));
  const image = images.find((i) => !/minimal/i.test(i.displayName));
  if (!image) throw new Error(`No se encontró imagen Ubuntu 24.04 para ${SHAPE}`);
  return { ads: ads.map((a) => a.name), subnet, image };
}

async function existingInstance() {
  const list = await oci('GET', IAAS, '/20160918/instances' + q({ compartmentId: COMPARTMENT, displayName: NAME }));
  return list.find((i) => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
}

async function waitRunningAndIp(id) {
  for (;;) {
    const inst = await oci('GET', IAAS, `/20160918/instances/${id}`);
    if (inst.lifecycleState === 'RUNNING') break;
    log(`Estado: ${inst.lifecycleState}…`);
    await sleep(15);
  }
  for (;;) {
    const atts = await oci('GET', IAAS, '/20160918/vnicAttachments' + q({ compartmentId: COMPARTMENT, instanceId: id }));
    const att = atts.find((a) => a.lifecycleState === 'ATTACHED');
    if (att) {
      const vnic = await oci('GET', IAAS, `/20160918/vnics/${att.vnicId}`);
      if (vnic.publicIp) return vnic.publicIp;
    }
    await sleep(10);
  }
}

async function main() {
  const res = await resolveResources();
  log(QUIET ? 'Cuenta OK.' : `Cuenta OK. AD: ${res.ads.join(', ')} | subred: ${res.subnet.displayName} | imagen: ${res.image.displayName}`);
  const found = await existingInstance();
  if (found) {
    log(`Ya existe la instancia "${NAME}" (${found.lifecycleState}).`);
    if (!process.argv.includes('--check')) log(`IP pública: ${done(await waitRunningAndIp(found.id))}`);
    return;
  }
  if (process.argv.includes('--check')) { log('Chequeo OK: listo para reintentar.'); return; }

  // Una sola petición por intento (Oracle responde 429 si se encadenan): se alternan AD y tamaño entre intentos.
  const combos = res.ads.flatMap((ad) => SHAPES.map(([ocpus, mem]) => ({ ad, ocpus, mem })));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(INTERVAL + Math.floor(Math.random() * 30));
    const { ad, ocpus, mem } = combos[(attempt - 1 + OFFSET) % combos.length];
    const size = FLEX ? `${ocpus} OCPU / ${mem} GB` : SHAPE;
    try {
      const inst = await oci('POST', IAAS, '/20160918/instances', {
        compartmentId: COMPARTMENT,
        availabilityDomain: ad,
        displayName: NAME,
        shape: SHAPE,
        ...(FLEX ? { shapeConfig: { ocpus, memoryInGBs: mem } } : {}),
        sourceDetails: { sourceType: 'image', imageId: res.image.id },
        createVnicDetails: { subnetId: res.subnet.id, assignPublicIp: true },
        metadata: { ssh_authorized_keys: sshKey, user_data: cloudInit.toString('base64') },
        instanceOptions: { areLegacyImdsEndpointsDisabled: true },
        availabilityConfig: { recoveryAction: 'RESTORE_INSTANCE' },
      });
      log(`✅ Instancia creada (${size}) en el intento ${attempt}. Esperando que arranque…`);
      log(`✅ IP pública: ${done(await waitRunningAndIp(inst.id))}`);
      return;
    } catch (e) {
      const capacity = e.status === 500 && /capacity/i.test(e.message);
      const throttled = e.status === 429;
      if (capacity) log(`Intento ${attempt}: sin capacidad (${size}).`);
      else if (throttled) { log(`Intento ${attempt}: demasiadas solicitudes, espero más.`); if (attempt < MAX_ATTEMPTS) await sleep(INTERVAL); }
      else if (e.status >= 500 || e.message === 'timeout' || !e.status) log(`Intento ${attempt}: error transitorio: ${QUIET ? e.status ?? e.message : e.message}`);
      else throw e; // 400/401/404/LimitExceeded: no tiene sentido reintentar
    }
  }
}

main().catch((e) => { log('❌', QUIET && e.status ? `${e.status} ${e.code ?? ''}` : e.message); process.exit(1); });
