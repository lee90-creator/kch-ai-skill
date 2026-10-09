# kch-ai 스킬

AI에게 말 한마디로 **KCH AI 현황관리**에 내 프로젝트를 등록하고 업데이트합니다.

## 설치

Codex, Claude Code 등 쓰고 있는 AI(앱이든 터미널이든)에게 이렇게 말하세요.

> https://github.com/lee90-creator/kch-ai-skill 이 스킬 설치해줘

<details>
<summary>AI가 설치 방법을 모를 때 (AI에게 보여 줄 내용)</summary>

이 저장소 전체를 스킬 폴더에 `kch-ai` 라는 이름으로 내려받으면 됩니다.

- Codex: `~/.codex/skills/kch-ai`
- Claude Code: `~/.claude/skills/kch-ai`

```
git clone https://github.com/lee90-creator/kch-ai-skill ~/.codex/skills/kch-ai
git clone https://github.com/lee90-creator/kch-ai-skill ~/.claude/skills/kch-ai
```

설치한 뒤 AI 앱을 다시 시작합니다. Node.js 18 이상이 필요합니다.
</details>

## 사용

프로젝트 폴더에서 AI에게:

- "kch-ai 스킬로 이 프로젝트 .md 파일 읽고 정리해서 현황관리에 올려줘"
- "kch-ai 스킬로 현황관리 업데이트해줘. 담당자에 김혜민 QA로 추가해줘"
- "QA 들어갔다고 현황관리에 올려줘"
- "이 스크린샷 현황관리에 첨부해줘"

> 주의: 웹/모바일 Claude 채팅에서는 안 될 가능성이 큽니다. Codex, Claude Code(앱·터미널 모두)에서 쓰세요.

AI가 프로젝트를 정리 문서(`kch-ai-project.md`)로 만들어 보여 주고, 확인하면 소개서·담당자·첨부까지 한 번에 올립니다.
처음 한 번은 브라우저에 [허용] 화면이 뜹니다. 누르면 끝입니다.

문의: lee90@kchglobal.co.kr
