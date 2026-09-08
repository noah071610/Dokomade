# Conventional Commits

## 형식

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Type

| type     | 의미                    |
| -------- | ----------------------- |
| feat     | 새 기능                 |
| fix      | 버그 수정               |
| docs     | 문서 변경               |
| style    | 포맷팅 (로직 변경 없음) |
| refactor | 리팩토링                |
| test     | 테스트 추가/수정        |
| chore    | 빌드, 설정 등           |
| perf     | 성능 개선               |

## 예시

```
feat(auth): add OAuth2 login support
fix(api): handle null response from payment gateway
docs(readme): update installation steps
```

## 규칙

- subject는 소문자 시작, 마침표 없음, 명령형 동사
- scope는 선택 사항 (영향받는 모듈/영역)
- body는 "왜" 변경했는지 설명
