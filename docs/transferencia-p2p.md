# Transferência de arquivo P2P

Plano de implementação. Escrito em 2026-10-19, contra o código em `0.1.39`.

**O que é:** alguém escolhe um arquivo (ou vários), o resto da sala vê a oferta por
**15 segundos**, e quem aceitar recebe os bytes direto da máquina do outro por
DataChannel — sem servidor de arquivo em lugar nenhum.

**O que não é:** não é o LocalSend. Sem descoberta na rede local, sem servidor HTTP,
sem porta aberta no firewall. A sala já existe e o ICE já existe; a transferência
pega carona nos dois.

---

## 1. O que já existe e decide o desenho

| fato | onde | consequência |
| --- | --- | --- |
| `signal` é repassado opaco (`to`, `dir`, `payload`) pelos dois servidores | `server/src/index.ts:203`, `worker/src/room.ts:238` | Comandos novos viajam sem tocar em servidor nenhum |
| `protocol.ts` é importado pelo renderer e pelos servidores | `src/shared/protocol.ts` | Um só contrato; tipos novos valem para os três |
| `PeerLink` é um `RTCPeerConnection` por papel (publisher/viewer), criado e destruído pelo ciclo de vida da **mídia** | `peer-link.ts:211`, `mesh-session.ts:1054` | Amarrar transferência aí é pegar carona num objeto que morre quando alguém para de transmitir |
| `MeshSession` é dono do `Signaling` e guarda os `iceServers` do `welcome` | `mesh-session.ts:285`, `mesh-session.ts:395` | É o único caminho de sinal, e a fonte de credenciais ICE |
| Renderer não tem `fs` (contextIsolation) | `src/main/index.ts:44` | Salvar em disco exige IPC novo |
| CSP não afeta DataChannel; `blob:`/`data:` já liberados | `src/renderer/index.html:27` | Nada a mudar |
| `tm-tile__volume-toggle.is-touched` é precedente de indicador de estado no controle | `mirante-rail.tsx:429` | Indicador no ícone é idiomático, não invenção |

---

## 2. Decisões

1. **Um `RTCPeerConnection` dedicado por transferência aceita.** Ciclo de vida
   independente, sem renegociar link vivo, sem tocar em `peer-link.ts`. Nada é
   criado antes do aceite.
2. **Lane `xfer` no verbo `signal`.** `StreamDir` vira `SignalLane = StreamDir | 'xfer'`.
   Custo: uma linha de tipo. Ganho: comando de arquivo nunca entra no `switch` de
   mídia, e nenhum servidor muda.
3. **Quem aceita é quem oferece o PC** (receiver-offerer). O aceite é o gatilho: o
   aceitador faz `createDataChannel` + `filePcOffer`, o remetente responde. Ninguém
   monta conexão para oferta que ninguém aceitou.
4. **Uma sessão, N arquivos.** Inspirado no `prepare-upload` do LocalSend: a oferta
   leva a lista, um aceite cobre o lote, um DC carrega tudo em sequência.
5. **Streaming direto para o disco, nunca na memória.** O corpo vai para um
   `createWriteStream` no main; `.<nome>.part` vira o arquivo final por `rename`.
   Teto é o disco, não a RAM.
6. **Seleção por `<input type="file" multiple>`** no renderer: dá `File` com `slice()`
   para ler em pedaços, sem IPC e sem precisar do path (`File.path` não existe mais
   no Electron 32+).
7. **Protocolo continua v1.** Cliente antigo que recebe `fileOffer` cai no `switch`
   sem `default` de `handleSignal` e ignora. A oferta expira em silêncio — nenhum
   `version_mismatch`, nenhuma sala quebrada.

---

## 3. Protocolo — `src/shared/protocol.ts`

```ts
export type SignalLane = StreamDir | 'xfer'
// ClientMessage / ServerMessage: dir: SignalLane (era StreamDir)

export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
}

| { cmd: 'fileOffer';    session: string; files: FileMeta[]; ttlMs: number }
| { cmd: 'fileAccept';   session: string }
| { cmd: 'fileDeny';     session: string; reason: string }
| { cmd: 'fileCancel';   session: string }
| { cmd: 'filePcOffer';  session: string; offer: SessionDescription }
| { cmd: 'filePcAnswer'; session: string; answer: SessionDescription }
| { cmd: 'fileIce';      session: string; candidate: IceCandidate }
```

Todos auto-descritivos. O roteamento é por `session`, **não** por `dir` — nada de
flip, porque o id já identifica a transferência e o par (`from`). `ttlMs` em vez de
timestamp absoluto: os dois relógios não são o mesmo relógio.

`session` é o `sessionId` do LocalSend: nomeia uma sessão inteira, com N arquivos.

---

## 4. Fluxo e estados

Remetente escolhe arquivo(s) → `offer(files)` → broadcast `fileOffer` para cada id de
`peers()`, com `expiresAt = now + 15_000` local.

```
remetente   oferecendo(15s) ──aceite──> enviando(progresso) ──saved──> pronto
                 │                          │
                 ├── ninguém aceitou ──> expirado
                 ├── Cancelar ──> cancelado (fileCancel para todos)
                 └── aceite tardio ──> fileDeny{reason:'expirado'}

receptor    ofertado(15s) ──Aceitar──> recebendo(progresso) ──> salvo(path, sha256)
                 ├── Recusar ──> fileDeny
                 ├── Cancelar ──> fileCancel + parcial apagado
                 └── timer estoura ──> some da área (sem PC órfão)
```

- **Validar sempre o aceite** contra o conjunto de ofertas pendentes do próprio
  remetente: `{session, peerId from, expiresAt}`. Aceite de quem não recebeu a oferta,
  de peer que não é o destinatário, ou depois de expirado → `fileDeny`. É o
  equivalente do `403 Invalid token or IP address` do LocalSend, e é o único trabalho
  de segurança real dessa parte.
- Aceite tardio **não** deixa o receptor pendurado: ele recebe `fileDeny` e fecha o PC
  que já tinha criado.
- Vários peers podem aceitar a mesma oferta: uma sessão por peer, cada uma lê o mesmo
  `File` por `slice()`.
- Teto de **3 sessões recebidas simultâneas** (senão vira thrash de disco) — o
  equivalente nosso do `409 Blocked by another session` deles.
- "Tentar de novo" reusa o `File` guardado e emite sessão nova, com janela nova.
  `ponytail:` sem resume byte a byte; adicione quando alguém reclamar de arquivo
  grande em Wi-Fi ruim.

---

## 5. Transporte de bytes

`createDataChannel(session, { ordered: true })` — relável e ordenado por padrão, então
não existe código de reordenação nem de retransmissão.

Frames de controle (texto) e pedaços (binário) no mesmo canal:

```
{ t:'begin', fileId }            remetente → receptor, antes dos pedaços do arquivo
{ t:'end',   fileId }            remetente → receptor, último frame do arquivo
{ t:'progress', fileId, bytes }  receptor → remetente, a cada ~250 ms
{ t:'saved', fileId, sha256 }    receptor → remetente
{ t:'failed', fileId, reason }   qualquer lado
```

```ts
// 128 KiB: abaixo do teto de mensagem do SCTP no Chromium, e folgado em memória.
const CHUNK = 128 * 1024
const HIGH_WATER = 4 * 1024 * 1024
dc.bufferedAmountLowThreshold = 1 * 1024 * 1024

for (let offset = 0; offset < file.size; offset += CHUNK) {
  if (dc.bufferedAmount > HIGH_WATER) await once(dc, 'bufferedamountlow')
  dc.send(await file.slice(offset, offset + CHUNK).arrayBuffer())
  // ponytail: freio por atraso, não token bucket. O PC da transferência tem
  // controle de congestionamento próprio e come a subida que a transmissão precisa.
  if (live) await delay(50)   // ~2,5 MB/s enquanto há transmissão no ar
}
dc.send(JSON.stringify({ t: 'end', fileId }))
```

Receptor conta bytes e **aborta** se passar do `size` anunciado. Só marca `salvo`
quando recebe `end` com a contagem batendo e o `rename` em disco deu certo.

`ponytail:` sem watchdog de canal travado-mas-aberto. O `connectionstatechange` e o
`close` do DC cobrem o caso comum; adicione o watchdog se aparecer stall real.

---

## 6. Persistência — `src/main/transfer.ts`

O main é a autoridade do nome e do disco. O renderer nunca decide caminho.

```
transfer:open   (session, files) -> { token, targets: Array<{fileId, path, name}> }
transfer:write  (token, fileId, chunk: ArrayBuffer)
transfer:close  (token, { ok: boolean }) -> { paths: string[] }
transfer:cancel (token)
transfer:reveal (path)
```

- `open`: sanitiza **todos** os nomes de uma vez, deduplica, abre um
  `createWriteStream` por arquivo em `.<nome>.part`, e devolve os caminhos finais
  (`targets`) para o painel mostrar o nome de verdade depois do dedupe.
- `write`: `stream.write(Buffer)` respeitando `drain()`; erro de escrita (ENOSPC, etc.)
  derruba a sessão e vira `failed`.
- `close`: espera o flush, **renomeia** `.part` → final. Rename é atômico no mesmo
  volume, então arquivo pela metade nunca aparece com cara de salvo. `ok:false` apaga
  todos os parciais.
- `cancel`: apaga parciais e fecha os streams.
- `reveal`: só `shell.showItemInFolder`. **Nunca** `shell.openPath` — nada executa
  sozinho.
- Destino: `app.getPath('downloads')`. Caminho resolvido é validado com prefixo do
  diretório de downloads antes de qualquer escrita ou reveal.
- **SHA-256 sai de graça** de `createHash` no mesmo stream (o Web Crypto é one-shot e
  não tem digest incremental — este é o argumento que sozinho já decide por streaming
  a disco em vez de Blob).

---

## 7. Segurança (fronteira de confiança — não simplificar)

- Nome vindo do par: `replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')`, sem ponto inicial,
  ≤120 caracteres, vazio → `arquivo`. Aplicado no main, não no renderer.
- Destino sempre dentro de `app.getPath('downloads')`; colisão → ` (1)`, ` (2)`.
- Nada é executado nem aberto automaticamente. Só revelar na pasta.
- `size` negativo, absurdo ou acima do teto de disco → oferta recusada.
- `sha256` recebido é **informativo**: não bloqueia a entrega nem a marca como salva.
  O DTLS do DataChannel já autentica o par e ordena os dados; o hash é defesa contra
  corrupção de transporte, não contra o par.
- DTLS **não é opcional**. O LocalSend oferece "desligue a criptografia pra ganhar
  velocidade" no troubleshooting dele; isso não se copia.
- Trust anchor: o fingerprint DTLS viaja dentro do SDP, que viaja no socket da sala —
  que já é autenticado pelo `peerId` do servidor. Mesma âncora do fingerprint de
  certificado do LocalSend, e sai de graça.

---

## 8. UI — a área de transferência

**Ícone:** entra em `.tm-dock__devices`, depois do microfone e antes do
`tm-dock__devices-fill` — mesmo quadrado de 34px, mesmo glifo de 16px, mesmo peso
visual dos outros dois.

```tsx
<div className="tm-dock__devices">
  <div className="tm-dock__device-pair">…câmera + caret…</div>
  <button className={`tm-dock__device${micOn ? ' is-on' : ''}`} …>…mic…</button>

  {/* Quadrado como os dois de cima: controle da sessão, não ação primária.
      Só o botão de transmitir carrega o acento cheio. */}
  <div className="tm-dock__transfer">
    <button
      type="button"
      className={`tm-dock__device${open || hasOffers ? ' is-on' : ''}`}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      title="Arquivos — enviar e receber"
      aria-label="Arquivos"
    >
      <IconFile size={16} />
    </button>
    {open && <TransferPanel onClose={() => setOpen(false)} />}
  </div>

  <span className="tm-dock__devices-fill" />
</div>
```

- **Não é toggle.** `aria-expanded`, não `aria-pressed`; `is-on` significa
  "painel aberto **ou** há oferta viva".
- **Cor:** a classe `is-on` já é exatamente isso —
  `color: var(--accent)`, `border-color: var(--accent-edge)`,
  `background: var(--accent-wash)` (`controls.css:1501`). Zero CSS novo.
  Acento, e não tally: vermelho neste app significa uma coisa só, "no ar"
  (`tokens.css:56`). Verde-fósforo é sinal de rede. Oferta esperando é uma ação
  disponível, que é o papel reservado ao acento.
- **Só oferta recebida acende.** Oferta que *você* mandou não: para o remetente não há
  nada a decidir, e acender no próprio gesto ensina que a cor não quer dizer nada.
- **Expirar tem que emitir.** O timer de 15 s remove a oferta do snapshot e chama
  `emit()`; sem isso o ícone fica aceso para sempre depois de uma oferta que ninguém
  aceitou. Contagem regressiva é tick local do painel (100 ms), nunca re-render do
  manager por segundo.
- **Sem piscar, sem pulso.** A cor é a mudança. Animação de atenção não existe em
  nenhum lugar deste app.

**Painel:** popover ancorado acima da fileira de devices (`.tm-dock__transfer {
position: relative }`), mesmo padrão do `app-mixer`. Duas listas:

- **Recebidas:** quem mandou, lista de arquivos com tamanho, contagem 15→0,
  Aceitar / Recusar. Durante a transferência: progresso por arquivo, Cancelar.
  No fim: caminho salvo + "Abrir pasta".
- **Enviadas:** nome do lote, estado, progresso por arquivo, Cancelar, Abrir pasta.

**Nada disso é adicionado, e é deliberado:**

- sem `tm-toast` / `shareError` (o único canal de aviso do app, `app.tsx:952`);
- sem som em `lib/sounds.ts` (nem `soundJoin`, que o mesh já toca);
- sem `Notification`, sem tocar em `MiranteRail`, `Stage` ou no overlay.

O único sinal fora do painel é o estado do próprio ícone.

---

## 9. Arquivos

| arquivo | ação | ~linhas |
| --- | --- | --- |
| `src/shared/protocol.ts` | `SignalLane`, `FileMeta`, 7 cmds | +22 |
| `src/shared/transfer.ts` | **novo** — constantes (`CHUNK`, `HIGH_WATER`, `OFFER_TTL_MS`), `sanitizeName`, `dedupeName`, `chunkCount` | ~70 |
| `src/renderer/src/rtc/transfer.ts` | **novo** — `TransferManager` + `useTransfers` | ~340 |
| `src/renderer/src/rtc/mesh-session.ts` | `transfers` público, `sendXfer`, rota `dir === 'xfer'`, `setIceServers`/`dropPeer`/`closeAll` | +25 |
| `src/renderer/src/components/transfer-panel.tsx` | **novo** — a área de transferência | ~200 |
| `src/renderer/src/components/control-dock.tsx` | ícone + `TransferPanel` | +20 |
| `src/renderer/src/components/icons.tsx` | `IconFile` | +8 |
| `src/renderer/src/lib/format.ts` | `formatBytes` | +8 |
| `src/renderer/src/styles/controls.css` | seção `.tm-dock__transfer` / `.tm-xfer*` | +90 |
| `src/main/transfer.ts` | **novo** — `registerTransferIpc()` | ~120 |
| `src/main/index.ts` | `registerTransferIpc()` no `whenReady` | +2 |
| `src/preload/index.ts` | `transfer: { open, write, close, cancel, reveal }` no `MiranteApi` | +26 |
| `scripts/transfer-check.mjs` | **novo** — self-check assert-based | ~60 |
| `README.md` | seção "Transferência de arquivo" + limite honesto | +25 |

Nada em `server/`, nada em `worker/`, nenhuma dependência nova.

`TransferManager` não importa `MeshSession`: recebe um transporte
(`{ send, peers, iceServers }`) e publica estado por `subscribe`/`getSnapshot`, igual
ao padrão de `use-session.ts`. Sem import circular.

`scripts/transfer-check.mjs`: `node scripts/transfer-check.mjs` roda asserts sobre
sanitização de nome, dedupe e aritmética de pedaços (`chunkCount`, último offset,
arquivo de 0 byte, arquivo múltiplo exato de `CHUNK`). É a parte com casos de borda e
com peso de segurança; não precisa de framework.

---

## 10. Verificação

1. `npm run typecheck` e `npm run build`.
2. `node scripts/transfer-check.mjs`.
3. Duas instâncias, `npm run signal`, sala comum: enviar 3 arquivos → aceitar →
   conferir bytes com `certutil -hashfile <arquivo> SHA256` nos dois lados, e comparar
   com o `sha256` mostrado no painel.
4. Negativos: (a) não aceitar em 15 s → oferta some dos dois lados, ícone apaga,
   nenhum PC pendurado; (b) recusar → `fileDeny` remove a oferta no remetente;
   (c) cancelar no meio, dos dois lados → parciais `.part` apagados, nada truncado em
   Downloads; (d) fechar uma instância no meio → entrada vira `falhou` e a UI não
   trava; (e) aceite depois de 15 s (forçar com um peer de teste) → `fileDeny` e o
   receptor não fica pendurado.
5. Regressão de compatibilidade: cliente antigo na sala recebe `fileOffer`, ignora, e
   a transmissão dele continua — é a prova de que o lane não encostou na mídia.
6. Transmissão de tela ativa durante o envio: confirmar que o fps da transmissão não
   desaba (é o que o `delay(50)` protege).

---

## 11. Limites honestos

- **Sem resume.** Queda no meio recomeça do zero.
- **O PC da transferência tem controle de congestionamento próprio** e disputa a
  subida com a transmissão. É por isso que existe o freio de 50 ms. No dia em que
  DataChannel e RTP dividirem um PC, o freio sai.
- **Transferência por TURN paga banda ao dono do coturn** — mesmo caminho de fallback
  da mídia, sem aviso no app.
- **Um DC ordenado por sessão**, arquivos em sequência: sem upload paralelo. Um canal
  só com retransmissão confiável não ganha nada paralelizando.
- **Sem watchdog de canal travado**, sem verificação automática de hash, sem PIN.
- Windows-only como o resto do app.

---

## 12. Decisões abertas (default escolhido; troca em uma linha)

1. **Painel não abre sozinho ao chegar oferta** — leitura literal de "não criar
   avisos". Risco: perder os 15 s. Alternativa: `TransferManager` avisa a UI para
   abrir na primeira oferta.
2. **Salva automático em Downloads**, com "Abrir pasta" depois. Diálogo de salvar não
   cabe na janela de 15 s; se for desejado, o diálogo teria que abrir **depois** da
   transferência completar.
3. **Teto de 3 sessões recebidas simultâneas.**

---

## 13. Apêndice — o que veio do LocalSend

Consulta: `localsend/localsend` (README) e `localsend/protocol` v2.1
(`prepare-upload` / `upload` / `cancel`).

**Tomado emprestado**

| do LocalSend | aqui |
| --- | --- |
| `prepare-upload` manda metadado e recebe aceite **antes** de qualquer byte | `fileOffer` → `fileAccept` → só então o PC existe |
| `sessionId` nomeia uma sessão com **N** arquivos | `session` + `files[]`, um aceite para o lote |
| `403 Invalid token or IP address` (token **e** identidade de quem chamou) | aceite validado contra `{session, peerId from, expiresAt}` |
| `/cancel?sessionId`, cancelável pelos dois lados, parcial apagado | `fileCancel` bidirecional + `.part` removido |
| `sha256` no metadado, marcado *nullable* | hash incremental no main, informativo, sem portão |
| Corpo escrito direto no sistema de arquivos | `createWriteStream` + `.part` → `rename` |
| `409 Blocked by another session` | teto de 3 sessões recebidas simultâneas |

**Deixado de fora**

- **Descoberta** (multicast UDP 224.0.0.167 + varredura HTTP de sub-rede): eles
  precisam porque não têm servidor. A nossa lista de peers vem do `welcome`/
  `peerJoined` — e por isso funciona fora da LAN, que é onde o LocalSend não vai.
- **Porta aberta no firewall** (53317/TCP+UDP): não escutamos porta nenhuma.
- **Pin**: receptor desatendido é o problema deles; o nosso aceite explícito de 15 s é
  o mesmo controle com menos fricção.
- **Upload paralelo** e a **"download API"** (transferência reversa pelo navegador).
- **Modo HTTP sem criptografia**, oferecido por eles como opção de velocidade.
