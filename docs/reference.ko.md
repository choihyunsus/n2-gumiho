[쉬운 시작 안내로 돌아가기](../README.ko.md)

# N2 구미호

구미호는 역할별 작업 맥락을 분리하는 Node.js 에이전트 하네스입니다. 공급자 하나만 등록해도 분석·계획·구현·검증 꼬리를 사용할 수 있습니다. 꼬리마다 모델, 공급자, 도구 권한과 출력 예산을 지정할 수 있습니다.

N2R이 준비와 최종 검증을 강제하고, Mimir가 Soul 공통 SQLite DB에 작업 결과와 근거를 저장합니다. 라이브러리 API와 CLI를 제공합니다.

[English documentation](reference.md)

## 설치

Node.js 22 이상이 필요합니다. 버전이 고정된 GitHub 릴리스 파일을 설치합니다.

```sh
npm install https://github.com/choihyunsus/n2-gumiho/releases/download/v1.0.1/n2-gumiho-1.0.1.tgz
```

런타임은 N2R 1.0.1과 Mimir 3.0.3을 사용합니다. N2R을 통해 Clotho 4.0.1과 Personas 1.0.0도 연결됩니다. 구미호 소스는 MIT이며, Mimir와 Clotho에는 각 배포판의 비상업·상업 이용 조건이 적용됩니다. [라이선스](../LICENSE), [의존성 고지](../THIRD-PARTY-NOTICES).

## 오프라인 예제 실행

연습용 작업 폴더와 DB 폴더를 만듭니다.

```sh
mkdir demo-workspace
mkdir demo-memory
npx --no-install n2-gumiho run --adapter ./node_modules/n2-gumiho/examples/file-task.cjs --db ./demo-memory/mimir.db --workspace ./demo-workspace --project demo --agent worker --run-id first-run --task "Create the demonstration file"
npx --no-install n2-gumiho status --db ./demo-memory/mimir.db --project demo --agent worker --run-id first-run
```

예제는 미리 정한 공급자 응답을 사용하면서 실제로 `gumiho-demo.txt`를 만들고 파일 내용을 검사합니다. 같은 이름의 파일에 다른 내용이 있으면 실패로 처리합니다. 조정 모드는 `--mode coordinator`와 새로운 작업 ID로 실행할 수 있습니다.

종료 코드는 성공 `0`, 오류·중단 `1`, 실패로 완료된 작업 `2`, 조회할 상태 기록 없음 `3`입니다.

## 로컬 모델 연결

`ollama-workspace.cjs`는 설치된 Ollama 모델, 크기가 제한된 UTF-8 파일 도구, 운영자가 지정한 프로젝트 검사를 사용합니다. 다음 환경 값을 설정한 뒤 어댑터를 불러옵니다.

| 환경 변수 | 용도 |
| --- | --- |
| `N2_GUMIHO_MODEL` | 사용할 설치 모델 이름, 필수 |
| `N2_GUMIHO_CHECK_ARGS` | 실제 프로젝트 검사 인수의 JSON 배열, 필수 |
| `N2_GUMIHO_CHECK_COMMAND` | 검사 실행 파일, 기본값은 현재 Node 실행 파일 |
| `N2_GUMIHO_CHECK_TIMEOUT_MS` | 검사 제한 시간, 기본 120000ms |
| `N2_GUMIHO_TOOL_MODE` | 기본 `native`, 로컬 JSON 도구 방식은 `json` |
| `N2_GUMIHO_CONTEXT_LENGTH` | 선택적인 Ollama 컨텍스트 길이 |
| `N2_GUMIHO_THINK` | JSON 불리언·null 또는 모델이 지원하는 생각 수준 문자열 |
| `N2_GUMIHO_OLLAMA_ENDPOINT` | 전체 채팅 엔드포인트, 기본값은 루프백 11434 포트 |

실제 `test` 디렉터리가 있는 Node 프로젝트의 PowerShell 설정 예시입니다. 모델 이름을 설치된 모델로 바꿔 주세요.

```powershell
$env:N2_GUMIHO_MODEL = 'YOUR_INSTALLED_MODEL'
$env:N2_GUMIHO_CHECK_ARGS = '["--test","test"]'
$env:N2_GUMIHO_CONTEXT_LENGTH = '8192'
npx --no-install n2-gumiho run --adapter ./node_modules/n2-gumiho/examples/ollama-workspace.cjs --db ./memory/mimir.db --workspace ./your-project --project your-project --agent worker --run-id change-1 --task "요청한 변경을 구현하고 프로젝트 테스트를 통과시켜 주세요"
```

생각 모드는 Ollama `/api/show`의 지원 기능과 해당 모델 문서를 확인해 선택합니다. 로컬 JSON 방식은 응답 구조를 제한하고 실행할 도구 인수를 다시 검증합니다. 명시한 `contextLength`와 `think`는 공급자 복원 식별값에 포함됩니다. [Ollama 생각 모드](https://docs.ollama.com/capabilities/thinking), [컨텍스트·동시 실행 설정](https://docs.ollama.com/faq).

예제 파일 도구는 기존 디렉터리와 32KiB 이하 UTF-8 파일을 다룹니다. 읽기 결과에 SHA-256을 반환합니다. 쓰기는 읽어 둔 해시 또는 새 파일을 뜻하는 `new`를 요구하고, 교체 직전에 다시 확인합니다. 없는 파일과 잘못된 경로는 모델이 수정할 수 있는 도구 실패 결과로 전달합니다.

## 라이브러리 사용

Ollama 환경 값과 DB 디렉터리를 준비한 뒤 다음 코드를 ES 모듈로 실행할 수 있습니다.

```js
import { Gumiho } from 'n2-gumiho';
import adapter from 'n2-gumiho/examples/ollama-workspace.cjs';

const app = await Gumiho.create({
  ...adapter,
  dbPath: './memory/mimir.db',
  workspaceRoot: './your-project',
  project: 'your-project',
  agent: 'worker',
  mode: 'pipeline',
});

try {
  const result = await app.run({
    runId: 'change-1',
    sessionId: 'session-1',
    task: '요청한 변경을 구현하고 검증해 주세요',
  });
  console.log(result.success, result.budget, result.verification);
} finally {
  await app.close();
}
```

`run`에 `AbortSignal`을 전달할 수 있습니다. `close`는 진행 중인 작업에 취소를 전달하고 협력적으로 종료되는 작업을 기다립니다. `status(runId)`는 상세 기록을 반환합니다. `inspectGumiho({dbPath, project, agent, runId})`는 읽기 전용 SQLite 연결로 일관된 상태 요약을 조회합니다.

## 실행 방식

### 파이프라인

기본 흐름은 분석 → 계획 → 구현 → 실제 검사 → 독립 리뷰입니다. 분석이나 계획이 실패하면 후속 작업을 멈춥니다. 검증 실패 시 수정 라운드를 진행하며, 기본 한 번이고 최대 세 번까지 설정할 수 있습니다.

기본 꼬리는 `analyze`, `plan`, `build`, `verify`입니다. 분석·계획·검증은 읽기 전용이고 구현 꼬리가 등록된 쓰기 도구를 사용합니다. `tails`를 직접 지정하면 그 목록이 기본 꼬리 구성을 대체합니다.

```js
const tails = [
  { id: 'analyze', role: 'analyze' },
  { id: 'plan', role: 'plan' },
  { id: 'build', role: 'build', maxOutputTokens: 4096 },
  { id: 'verify', role: 'verify', model: 'YOUR_REVIEW_MODEL' },
];
```

다른 공급자는 `providers`에 등록한 뒤 꼬리의 `providerId`로 선택합니다. `tools: []`는 빈 도구 권한을 뜻합니다. `tools`를 생략하면 해당 꼬리의 읽기 전용 설정에 맞는 도구가 허용됩니다.

### 조정 모드

`mode: 'coordinator'`로 설정합니다. 조정 전용 대화는 `coordinator.sourceTail`의 모델 연결을 이어받으며, 기본값은 첫 번째 꼬리입니다. 위임할 대상은 `coordinator.targets`로 별도 지정합니다.

보스는 한 묶음에 최대 네 개의 독립 작업을 위임하고, 실패한 작업을 재시도하고, 저장된 근거를 조회하고, 실제 검사와 독립 리뷰를 요청할 수 있습니다. 읽기 작업은 제한된 개수로 병렬 실행하고 쓰기 작업은 작업 폴더를 독점합니다. 자식 작업의 효과가 발생하기 전에 위임 계획부터 저장합니다.

완료하려면 미해결 작업이 정리되어야 하고, 현재 파일 해시와 작업 근거 해시에 맞는 검증 승인이 필요합니다. 파일 내용이 같아도 이후 작업 결과가 추가되면 다시 검증해야 합니다. 실패했던 작업과 명시적인 대체 관계는 기록에 남습니다.

```js
const coordinator = {
  sourceTail: 'plan',
  verifyTail: 'verify',
  targets: ['analyze', 'plan', 'build'],
  maxTurns: 16,
};
```

두 방식 모두 `advisorTail`, `advisorMaxCalls`로 읽기 전용 조언자를 선택할 수 있습니다. 계획·막힌 작업·마지막 검토 시점을 코드가 호출합니다. 조언 예산을 다 쓰면 해당 시점을 생략한 기록을 남깁니다. 모델과 공급자의 역할별 분리는 선택 사항입니다.

## 공급자 어댑터

모든 생성 함수는 명시적인 `id`, `model`을 요구합니다.

| 생성 함수 | 프로토콜과 설정 |
| --- | --- |
| `openAIResponses` | Responses API, `apiKey`, 상태 비저장 응답 재전달 |
| `anthropicMessages` | Messages API, `apiKey`, API 버전 2026-10-21 |
| `geminiInteractions` | Interactions API, `apiKey`, 시간순 실행 단계 재전달 |
| `ollamaChat` | 네이티브 호출 또는 로컬 JSON 방식, `contextLength`, `think` 선택 가능 |
| `openAICompatible` | 전체 엔드포인트 지정, 키 선택 가능, 출력 제한 필드 선택 가능 |

지원하는 공급자 연속성 데이터와 도구 호출·결과 묶음을 보관합니다. 등록한 JSON 스키마를 통과해야 호스트 도구를 실행합니다. 엔드포인트는 HTTPS와 루프백 HTTP를 지원합니다. HTTP 응답 크기를 제한하고 진단에서 민감한 요청 정보를 걸러 내며, 429·503 재시도는 제한된 서버 대기 시간을 따릅니다.

Gemini의 생성 토큰 집계에는 별도로 보고되는 생각 토큰을 포함합니다. 출력 제한에도 생각 토큰이 포함되므로 모델 특성에 맞는 꼬리 출력 예산을 지정해야 합니다. [Google 생각·토큰 제한](https://aistudio.google.com/docs/thinking).

공급자별 함수 호출과 대화 상태 계약을 따라 구현했습니다. [OpenAI 함수 호출](https://developers.openai.com/api/docs/guides/function-calling), [Claude 도구 결과](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Gemini 함수 호출](https://aistudio.google.com/docs/function-calling), [Ollama 채팅](https://docs.ollama.com/api/chat).

사용자 정의 `ModelProvider.generate(request)`는 `text`, `calls`, `stop`, `model`과 null을 허용하는 토큰 사용량을 반환합니다. 취소 신호와 출력 제한을 지켜야 합니다. 재시도를 포함한 실제 요청마다 `request.onAttempt`를 호출합니다. 콜백을 생략한 사용자 구현에도 구미호가 첫 요청 예산을 예약합니다.

모델 요청 ID와 호스트 도구 호출 ID는 프로젝트·주체·실행·작업·턴을 구분합니다. 중단된 호출을 복원하면 같은 ID를 사용하고, 별도 실행에는 다른 ID를 부여합니다. 공급자와 호스트는 이 값을 멱등 처리에 사용할 수 있습니다.

## 도구와 실제 검증

`GumihoTool`은 이름, 버전, 설명, 동기식 JSON 객체 스키마, 권한, 실행 함수를 선언합니다. 결과에는 `success`, `output`을 넣고 필요하면 `data`, `modifiedFiles`를 추가합니다. 예상 가능한 작업 오류는 `success: false`로 반환합니다. 예외가 발생하면 복원할 수 있도록 중단된 호출을 남깁니다.

도구 이름은 N2R의 ASCII 식별자 규칙을 따릅니다. 공급자 형식에 맞춰야 하는 이름에는 별칭을 만듭니다. 읽기 전용 설정은 도구 허용 범위를 결정하므로 실제 구현에 맞게 선언해야 합니다. 호스트 도구와 검사 명령은 호스트 프로세스 권한으로 실행됩니다. OS 격리, 외부 편집기와의 충돌 관리, 권한 강제는 연결하는 호스트가 담당합니다.

버전이 있는 `NativeVerifier`를 제공하거나 `commandVerifier(checks, version)`로 고정된 검사 명령을 구성합니다. 검사 출력과 실행 시간을 제한합니다. 독립 리뷰는 정확한 스냅샷 해시와 구조화된 지적 사항을 반환해야 합니다. 실제 검사 실패, 차단 수준의 지적, 달라진 파일, 미해결 작업은 성공 처리를 막습니다.

리뷰 출력은 JSON 객체 또는 하나의 완전한 JSON 코드블록을 받습니다. 두 형식에 같은 필드 타입·스냅샷 해시·차단 수준 검사를 적용합니다. 추가 설명이나 여러 코드블록이 섞이면 리뷰 실패로 처리합니다.

마지막 실제 검사는 현재 외부 근거를 다시 확인합니다. 검사 기록은 N2R 검증 호출과 연결됩니다. 리뷰 품질과 테스트 범위는 선택한 모델 및 실제 검사 구현에 따라 달라집니다.

## Soul 공통 DB

Soul·Mimir와 동일한 SQLite 파일을 명시적으로 지정합니다. `project`, `agent`, `session_id`, `source_ref`, `context`, `action`, `outcome` 등 공통 필드는 같은 의미로 사용합니다.

구미호는 `gumiho_schema_version = 1` 아래에 여섯 개 테이블을 추가합니다.

| 테이블 | 저장 내용 |
| --- | --- |
| `gumiho_runs` | 작업 식별값과 자원 사용량 |
| `gumiho_jobs` | 역할별 작업, 결과, 대체 관계 |
| `gumiho_calls` | 진행 중·완료된 모델 및 도구 호출 |
| `gumiho_leases` | 프로젝트·주체·작업 폴더 점유 정보 |
| `gumiho_events` | 실행 이벤트 |
| `gumiho_receipts` | 스냅샷과 검증·완료 근거 |

N2R은 자체 수명주기 테이블을 사용하고 최종 저장이 성공하면 범위가 지정된 결과를 한 건 기록합니다. 실패로 완료된 작업은 실패 경험으로 기록합니다. N2R 작업 ID에는 `gumiho-` 접두사를 사용합니다. 버전 정보가 없는 기존 구미호 테이블은 명시적인 이전 절차가 필요합니다.

## 중단 후 복원

실행 형식 ID `1.0.0`으로 저장 기록의 규약을 식별합니다. 1.0.1 배포판은 조건이 일치하는 1.0.0 기록을 복원합니다. 공급자·도구·검증기·작업 설정은 재실행 식별 정보에 포함됩니다.

같은 작업 ID, 세션 ID, 요청과 설정으로 다시 실행합니다. 완료된 호출은 저장된 결과를 사용합니다. 멱등성이 선언된 미완료 작업은 재실행할 수 있습니다. 효과가 불확실한 비멱등 호스트 호출은 `ReconciliationRequired`로 멈춥니다.

실제 효과를 확인한 뒤 해당 호스트 도구 호출에 결과와 근거를 등록합니다.

```js
await app.reconcileTool(
  'change-1',
  'tool-INVOCATION_ID',
  { success: true, output: '읽어 본 내용이 예상 결과와 일치함', modifiedFiles: ['src/example.ts'] },
  '영향받은 파일의 실제 내용을 예상 결과와 비교해 확인함',
);
```

CLI에서는 `reconcile`에 `--call-id`, `--result`, `--evidence`를 전달합니다. 조정 모드의 복합 작업은 개별 자식 호출 기록을 통해 이어집니다. 엔진 버전, 모델 연결, 도구·검사 버전, 예산이나 작업 정책을 바꾸면 새 작업 ID를 사용합니다.

완료 기록은 당시의 검증 결과를 나타냅니다. 성공한 작업을 저장한 상태에서 중단됐다면 완료 전에 현재 근거가 계속 일치하는지 확인합니다. 미완료 모델 요청에도 공급자 사용량이 발생했을 수 있으며, 재시도는 새 요청 예산을 사용합니다.

## 자원과 파일 범위

| 기본 설정 | 값 |
| --- | --- |
| 로컬·클라우드 모델 동시 실행 | 1 / 2 |
| 읽기 전용 작업 병렬 실행 | 2 |
| 작업·모델 요청·도구 호출 | 64 / 64 / 128 |
| 작업당·조정자 모델 턴 | 16 / 16 |
| 꼬리 호출당 출력 요청 | 2048토큰 |
| 전체 출력 예약 | 131072토큰 |
| 모델 대화·영구 실행 기록 | 256KiB / 32MiB |
| 모델·도구·작업 제한 시간 | 120초 / 120초 / 600초 |
| 외부 N2R 작업 제한 시간 | 1시간 |
| 스냅샷 파일 수·개별 크기·전체 크기 | 2000개 / 16MiB / 256MiB |
| 스냅샷 목록 크기 | 512KiB |

대화를 줄일 때 도구 호출과 결과의 완전한 묶음을 유지합니다. 꼬리는 내부 조회 도구로 작업·호출·검증 기록의 전체 내용을 페이지 단위로 읽을 수 있습니다. 공급자가 사용량을 제공하지 않으면 null로 남깁니다. 출력 예약은 실행 한도이며 금액 견적은 별도 산정해야 합니다.

기본 스냅샷은 `.git`, `node_modules`, `target`, `dist`, `.next`와 구미호 DB의 보조 파일을 제외합니다. 그 디렉터리가 작업 결과에 포함되면 `snapshot` 정책을 지정합니다. 보고한 파일 변경은 해당 정책에 포함되어야 하며 일반 파일의 정규 경로를 사용해야 합니다. 심볼릭 링크는 링크 정보로 기록합니다. 지원 범위 밖의 특수 파일은 명시적으로 실패합니다. 한 작업에서 보고할 수 있는 파일 변경은 최대 1024개입니다.

작업 폴더 점유는 같은 DB를 사용하는 구미호 실행들 사이에서 조정합니다. 호스트 콜백은 취소 신호에 협력해야 합니다. 호스트 감독 범위를 벗어나 생성된 자식 프로세스의 종료에는 플랫폼별 한계가 있습니다.

## 개발과 검증

```sh
npm ci
npm test
npm run typecheck:consumer
npm audit --omit=dev --audit-level=low
npm pack
```

정상 API·CLI 진입점, 실제 파일 쓰기와 검사, 공급자 HTTP 모의 서버, 역할 분리, 동시 실행, 프로세스 강제 종료 복원, 트랜잭션 되돌리기, 오래된 근거 차단, 실패 작업 대체 관계, 공통 스키마 보존을 시험합니다. ESM·CommonJS 소비자 타입은 의존성 검사까지 켜서 확인합니다. CI는 Windows·Linux·macOS에서 실행합니다.

실모델의 정확도·지연·비용은 선택한 모델, 하드웨어와 작업 집합으로 평가해야 합니다. 오프라인 예제와 HTTP 모의 시험은 프로토콜 및 수명주기를 재현 가능하게 검증합니다.
