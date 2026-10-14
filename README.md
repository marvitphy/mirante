# Mirante

Suba no mirante. Mostra a tela. Assiste junto.

App desktop para compartilhar tela e câmera ao vivo entre amigos. Mesh P2P — o
vídeo vai direto de uma máquina para a outra, sem passar por servidor de mídia.

---

## Rodar

```bash
npm install
npm run signal     # terminal 1 — servidor de sinalização em :8787
npm run dev        # terminal 2 — o app
```

Abra duas instâncias, entre na mesma sala com nomes diferentes, e transmita.

### Build

```bash
npm run build      # typecheck + bundle
npm run dist       # instalador Windows (NSIS)
```

---

## Arquitetura

```
┌───────────────────────────────────────────────────────────┐
│ Electron main                                             │
│   capture.ts        desktopCapturer + picker próprio      │
│   process-audio.ts  captura de áudio por aplicativo       │
│   hotkeys           funcionam com o jogo em foco          │
└──────────────────────────┬────────────────────────────────┘
                           │ contextBridge (preload)
┌──────────────────────────┴────────────────────────────────┐
│ Renderer (React)                                          │
│   mesh-session.ts   topologia — o "StreamBase" daqui      │
│   peer-link.ts      um RTCPeerConnection por espectador   │
│   sdp.ts            codecs, bitrate, Opus, contentHint    │
│   audio-mixer.ts    volume por pessoa + medidor de nível  │
└───────────────────────────────────────────────────────────┘
                           │ WebSocket (só sinalização)
┌──────────────────────────┴────────────────────────────────┐
│ server/  salas, descoberta de peers, credenciais TURN     │
│          mídia NUNCA passa por aqui                       │
└───────────────────────────────────────────────────────────┘
```

### Protocolo de sinalização

Cinco verbos:

| verbo | significado |
| --- | --- |
| `joinResponse` | admissão **e** oferta na mesma mensagem — economiza um RTT |
| `offer` / `answer` | SDP padrão |
| `iceCandidate` | trickle ICE |
| `reconnectOffer` | retoma depois de uma queda, sem derrubar a sessão |

---

## Decisões técnicas

| técnica | onde está |
| --- | --- |
| Um encoder só para N espectadores | `peer-link.ts` — a **mesma** `MediaStreamTrack` vai para todas as conexões. Nunca clonar: é o que deixa o Chromium compartilhar o encoder. CPU O(1) em vez de O(N). |
| `contentHint = 'detail'` + `maintain-resolution` | `sdp.ts` — texto continua nítido sob congestionamento, derruba fps em vez de resolução |
| Ordem de codec AV1 → VP9 → H.264 High | `sdp.ts` — AV1 ganha muito em conteúdo de tela |
| Opus `ptime:10`, estéreo, 320 kb/s, `useinbandfec=1`, `usedtx=0` | `sdp.ts` — frames de 10 ms cortam metade do atraso de empacotamento |
| Trickle ICE + `joinResponse` fundido | `peer-link.ts`, `protocol.ts` |
| `reconnectOffer` como verbo de primeira classe | `peer-link.ts#restartIce` |
| Telemetria via `getStats()` como ornamento | `signal-meter.tsx` — não é painel escondido, é a barra embaixo de cada pessoa |
| Abstração de topologia | `mesh-session.ts` — nada acima dela conhece `RTCPeerConnection`. Trocar por SFU mexe só nesse arquivo. |

### O que fazemos melhor

1. **TURN de verdade.** Sem retransmissor, a escada de fallback para em
   candidato TCP host e quem está atrás de NAT simétrico simplesmente não
   conecta. O servidor emite credenciais efêmeras (ver abaixo).
2. **Áudio por aplicativo de verdade** — ver próxima seção.

### Limite honesto do mesh

Encodar uma vez resolve CPU, **não resolve upload**. Uma transmissão de 8 Mb/s
para 5 pessoas precisa de 40 Mb/s de subida, que nenhuma internet doméstica tem.
O servidor limita a sala a 8 pessoas (`MAX_PEERS_PER_ROOM`); na prática conte com
**4 espectadores** numa transmissão pesada. Acima disso o caminho é SFU, e a
abstração em `mesh-session.ts` existe para esse dia.

---

## Áudio por aplicativo (o fim do eco)

Loopback de sistema captura tudo que sai da caixa de som — inclusive a voz dos
seus amigos voltando. É daí que vem o eco clássico de transmissão.

A solução é capturar **um processo só**. A voz nunca entra no buffer, então não
há o que filtrar.

`native/process-audio/` implementa isso com
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 build 20348+):

```bash
npm --prefix native/process-audio install
npm --prefix native/process-audio run build   # precisa de Rust + MSVC
```

> **Não compilado ainda.** A máquina onde isto foi escrito não tinha toolchain
> Rust (`cargo: command not found`), então `native/process-audio/src/win.rs`
> nunca passou por um `cargo build`. Trate a primeira compilação como parte do
> bring-up. O app funciona sem o addon — o seletor some e sobra "sem áudio" ou
> áudio do sistema com aviso explícito de eco.

Apps que carregam voz (`discord.exe`, `ts3client_win64.exe`, `teams.exe`,
`zoom.exe`, o próprio `tvmirante.exe`…) são filtrados da lista em
`process-audio.ts#VOICE_APPS`, então nem dá pra escolher o eco por engano.

---

## Servidor de sinalização

```bash
npm --prefix server install
PORT=8787 npm --prefix server run dev
```

Variáveis:

| variável | padrão | para quê |
| --- | --- | --- |
| `PORT` | `8787` | porta do WebSocket |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | descoberta de IP público |
| `TURN_URLS` | — | retransmissor, ex. `turn:seu.host:3478` |
| `TURN_SECRET` | — | segredo compartilhado com o coturn |
| `TURN_TTL_SECONDS` | `43200` | validade da credencial |
| `MAX_PEERS_PER_ROOM` | `8` | teto da sala |

Sem `TURN_URLS` o servidor sobe em modo STUN-only e avisa no log. Funciona para
a maioria das redes domésticas e falha para NAT simétrico.

No coturn, use o esquema `use-auth-secret` com o mesmo `TURN_SECRET`:

```
use-auth-secret
static-auth-secret=<TURN_SECRET>
realm=seu.host
```

---

## Atalhos

Globais (funcionam com o jogo em foco):

| tecla | ação |
| --- | --- |
| `Ctrl+Shift+S` | transmitir / parar |
| `Ctrl+Shift+C` | câmera |
| `Ctrl+Shift+M` | microfone |

Na janela:

| tecla | ação |
| --- | --- |
| `F` | tela cheia |
| `T` | modo teatro |
| `Esc` | voltar ao normal |
| `M` | silenciar quem está no palco |
| `↑` `↓` | volume de quem está no palco |
| `←` `→` | trocar quem está no palco |
| `D` | telemetria (botão no palco) |

---

## Design

Mundo: um mirante à noite sobre a cidade. Céu azul-preto frio, luzes âmbar lá
embaixo, lâmpada vermelha de câmera no ar.

- Profundidade por **bordas e deslocamento de superfície**, zero sombra — em
  fundo escuro sombra não lê.
- Uma única cor de destaque (âmbar), usada em ~10% da tela.
- Âmbar significa "ação principal". Vermelho significa "no ar". Verde-fósforo
  significa "sinal bom". Nenhuma cor é decoração.
- `Archivo` na interface, `IBM Plex Mono` em todo número.

Tokens em `src/renderer/src/styles/tokens.css`.


---

## Publicar pros amigos (GitHub Releases + atualização automática)

### Uma vez só

1. **Suba o servidor de sinalização em algum lugar público.** Sem isso nada
   funciona fora da sua máquina — o app precisa de um endereço que todo mundo
   alcance. É um processo Node pequeno (`server/`), roda em qualquer VPS de
   5 dólares, Fly.io, Railway. Use `wss://` (TLS), porque `ws://` é bloqueado
   por muita rede.

2. **No GitHub:** Settings → Secrets and variables → Actions → Variables → nova
   variável `MIRANTE_SIGNAL_URL` com o endereço, ex. `wss://mirante.seudominio.com`.
   O `GITHUB_TOKEN` já existe sozinho, não precisa criar nada.

3. **Ajuste `repository.url` no `package.json`** pro seu repositório de verdade.

### A cada versão

```bash
npm version patch      # ou minor / major — cria o commit e a tag
git push --follow-tags
```

O workflow `.github/workflows/release.yml` compila no Windows, gera o ícone,
publica o instalador NSIS na Release **e** o `latest.yml` — que é o arquivo que
as cópias já instaladas consultam.

### Como a atualização chega neles

`electron-updater` consulta a Release na abertura e a cada 6 horas, baixa em
segundo plano e avisa. O indicador fica no dock, ao lado do Sair:

| estado | o que aparece |
| --- | --- |
| em dia | ponto apagado · clicável pra checar na hora |
| checando | ponto pulsando |
| baixando | barra fina com a porcentagem |
| pronto | botão lilás **Atualizar** com o número da versão |

**Nunca reinicia sozinho.** Fechar o app no meio de uma transmissão pra instalar
é a coisa mais grosseira que um app ao vivo pode fazer — o download acontece
antes de você ser perguntado, então aceitar é instantâneo, mas o momento é
escolha de quem está assistindo. Quem não clicar leva a atualização no próximo
fechamento normal.

### Duas ressalvas honestas

**O instalador não é assinado.** O SmartScreen vai mostrar "Windows protegeu seu
PC" na primeira instalação de cada amigo — eles precisam clicar em "Mais
informações" → "Executar assim mesmo". Resolver isso exige um certificado de
assinatura de código pago (algumas centenas de dólares por ano). As atualizações
seguintes são silenciosas; o aviso é só na primeira instalação manual.

**Só Windows por enquanto.** O workflow roda em `windows-latest` e gera NSIS. O
macOS precisaria de notarização da Apple, e a captura por aplicativo é
Windows-only de qualquer forma.
