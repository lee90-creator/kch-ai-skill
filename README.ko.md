[English](README.md) | 한국어

<p align="center">
  <img src="assets/banner.png" alt="kch-ai" width="100%">
</p>

# kch-ai 스킬

AI에게 말 한마디로 **KCH AI 현황관리**에 내 프로젝트를 등록하고 업데이트합니다.

## 설치

Codex, Claude Code 등 쓰고 있는 AI(앱이든 터미널이든)에게 이렇게 말하세요.

> https://github.com/lee90-creator/kch-ai-skill 이 스킬 설치해줘

한 번만 설치하면 이 PC의 Codex, Claude Code 등 어디서든 쓸 수 있습니다. 업데이트도 같은 말("이 스킬 업데이트해줘")이면 됩니다.

<details>
<summary>AI가 설치 방법을 모를 때 (AI에게 보여 줄 내용)</summary>

1. 이 저장소를 아무 폴더에나 받습니다 (`git clone https://github.com/lee90-creator/kch-ai-skill` 또는 zip 다운로드 후 압축 풀기).
2. 받은 폴더에서 `node scripts/install.mjs` 를 실행합니다.
   - 스킬을 이 PC에 한 벌만 두고(`~/.kch-ai/skill`), Codex(`~/.codex/skills/kch-ai`), Claude Code(`~/.claude/skills/kch-ai`), Aside 가 모두 그 한 벌을 보도록 연결합니다.
3. AI 앱을 다시 시작합니다. Node.js 18 이상이 필요합니다.
</details>

## 사용

프로젝트 폴더에서 AI에게:

- "kch-ai 스킬로 이 프로젝트 .md 파일 읽고 정리해서 현황관리에 올려줘"
- "kch-ai 스킬로 현황관리 업데이트해줘. 담당자에 김혜민 QA로 추가해줘"
- "QA 들어갔다고 현황관리에 올려줘"
- "이 스크린샷 현황관리에 첨부해줘"
- "현황관리가 이 저장소 코드 읽을 수 있게 연결해줘" (비공개 저장소는 GitHub 승인 화면에서 Install·Authorize 한 번)

> 주의: 웹/모바일 Claude 채팅에서는 안 될 가능성이 큽니다. Codex, Claude Code(앱·터미널 모두)에서 쓰세요.

AI가 프로젝트를 정리 문서(`kch-ai-project.md`)로 만들어 보여 주고, 확인하면 소개서·담당자·첨부까지 한 번에 올립니다.
처음 한 번은 브라우저에 [허용] 화면이 뜹니다. 누르면 끝입니다.
GitHub를 안 쓰거나 비공개라 코드를 못 읽는 프로젝트는, 올릴 때 폴더의 코드를 "제출 코드 묶음"으로 함께 보냅니다(관리자 검토에만 쓰이고 직원에게는 안 보임).
비공개 저장소라면 올린 뒤 "코드를 읽지 못합니다" 안내가 나옵니다. 읽기 연결(저장소는 비공개 유지, 추천) 또는 공개 전환(키 검사 후) 중에 고르면 됩니다.

문의: lee90@kchglobal.co.kr
