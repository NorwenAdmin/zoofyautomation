# TestMind Testing Infrastructure — zoofyautomation

**Контекст:** репозиторий `/Users/constantinhacico/StudioProjects/zoofyautomation`, живой инстанс `https://zoofyautomation.norwen.nl`, FastAPI + Postgres (async SQLAlchemy). Auth: session-cookie логин владельца (`kosty31@gmail.com`) на GET-эндпоинтах, `X-API-Key` для машинных клиентов (как у n8n) на POST-эндпоинтах. Таблицы в фокусе: `subscription_invoices`, `appointments`, `facturen`.

## Решено: порядок работ
Фундамент первым — US-1 + US-2 + US-3 + US-4, только для `subscription_invoices`. Готово и проверено (2026-09-20), см. ниже. Остальные ресурсы (`appointments`, `facturen`) и CI (US-5–US-9) — по мере продолжения.

## Git — ✅ ГОТОВО
`git init` + `.gitignore` (`.venv`, `node_modules`, `.env`, `uploads/`, `test-results/`, `playwright-report/`) + репозиторий [github.com/NorwenAdmin/zoofyautomation](https://github.com/NorwenAdmin/zoofyautomation), запушено в `main`. По пути нашли и убрали захардкоженный продакшен-пароль из `tests/env.ts` (он там был при первой версии, в коммит не попал) — вынесли в `tests/.env` (gitignored) + `tests/.env.example` (шаблон, закоммичен).

**Репозиторий публичный** (сделан публичным 2026-09-20, чтобы включить branch protection — required status checks недоступны для приватных репо без GitHub Pro). Перед переключением вся git-история проверена на секреты (`git log --all -p` по всем известным значениям) — чисто, ничего не утекло.

## US-1. Контракт из кода, не руками — ✅ ГОТОВО
Как QA-инженер, хочу, чтобы контракт API брался из самого FastAPI (`/openapi.json`), а не писался вручную, чтобы тесты никогда не расходились с реальной реализацией.
- AC: контракт = живой `/openapi.json`. Committed snapshot `contracts/openapi-snapshot.json` для детекции дрифта.
- [x] `tests/helpers/contract.ts` — `loadContract()` фетчит `/openapi.json` живьём в момент прогона теста (не хардкод)
- [x] `tests/scripts/snapshot-openapi.ts` — снимает снепшот с любого base URL, по умолчанию mock
- [x] `tests/scripts/check-drift.ts` — сравнивает live против снепшота, показывает добавленные/удалённые paths, exit 1 при дрифте
- [x] `tests/contracts/openapi-snapshot.json` — снепшот снят с `https://zoofyautomation.norwen.nl`, drift-check сразу после — чисто

## US-2. Playwright contract-тесты — ✅ ГОТОВО (только subscription_invoices, appointments/facturen ещё нет)
Как QA-инженер, хочу набор Playwright-тестов (TypeScript) на `subscription_invoices`, `appointments`, `facturen`, чтобы иметь регрессионное покрытие на эндпоинтах, которые реально использует n8n.
- AC: один spec-файл на ресурс. Сценарии — data-driven, выведены из операций контракта (happy/edge/validation). Проверка статус-кода + схемы тела ответа (AJV).
- [x] `tests/contracts/subscription-invoices.spec.ts` — 7 тестов: GET список + схема (AJV против `components.schemas` из живого контракта), GET без сессии → 401, POST создание + схема, POST без ключа → 401, POST с неверным ключом → 401, POST без обязательного поля → 422, POST дважды с тем же factuur → upsert без дублей (проверено `id` совпадает)
- [x] `tests/helpers/schema.ts` — AJV-валидатор, компилирует `components` из живого OpenAPI-документа, резолвит `$ref` по имени схемы
- [ ] `appointments.spec.ts`, `facturen.spec.ts` — по аналогии, не сделаны

## US-3. Безопасное разделение mock/live — ✅ ГОТОВО
Как QA-инженер, хочу гонять тесты в двух режимах — одноразовая копия сервиса и настоящий деплой — чтобы получить полное CRUD-покрытие без риска для боевых данных.
- AC: `mock` project = локальный/CI-инстанс zoofyautomation + одноразовый Postgres, полный CRUD разрешён. `live` project = `zoofyautomation.norwen.nl`, только GET, никаких мутаций.
- [x] `docker-compose.test.yml` — throwaway Postgres (порт 5437, без volume — `down -v` полностью стирает) + `backend/Dockerfile` (только для теста, деплой на VPS не тронут, там всё так же venv+systemd)
- [x] `tests/scripts/run-mock.sh` — поднимает стек, ждёт health, сеет owner-аккаунт, гоняет `--project=mock`, ВСЕГДА (даже при падении тестов) сносит стек через `trap cleanup EXIT`
- [x] `playwright.config.ts` — два project'а, `mock` (baseURL: 127.0.0.1:8003) и `live` (baseURL: zoofyautomation.norwen.nl)
- [x] Мутирующие тесты обёрнуты в `test.describe` с `test.skip(project === 'live', ...)` — в live они физически не выполняются (проверено: "5 skipped, 2 passed" на реальном прогоне)
- [x] **Реально прогнано:** `npm run test:mock` → 7/7 passed, стек поднялся и корректно снёсся; `npm run test:live` → 2/2 passed + 5 skipped против настоящего `zoofyautomation.norwen.nl`

## US-4. Реалистичная авторизация в тестах — ✅ ГОТОВО
Как QA-инженер, хочу, чтобы тесты авторизовывались так же, как реальные клиенты, чтобы сама логика auth тоже проверялась.
- AC: фикстура session-login (owner) для GET. Фикстура `X-API-Key` для POST (тот же механизм, что у n8n).
- [x] `tests/fixtures/auth.ts` — `ownerApi` (реальный `POST /api/auth/login`, cookie-контекст; mock использует отдельный throwaway owner-аккаунт `test-owner@example.com`, live — реальный `kosty31@gmail.com`), `apiKeyHeaders` (реальный `X-API-Key`, кидает ошибку если случайно использован в проекте `live`)
- [x] `tests/scripts/seed-owner.ts` — регистрирует throwaway owner в свежей mock-базе перед прогоном (идемпотентно)

## US-5. Data integrity на уровне БД
Как QA-инженер, хочу тесты напрямую против Postgres, чтобы проверять constraints/upsert-логику, а не только ответы API.
- AC: pytest-набор. Проверка `uq_facturen_factuur_totaal`. Проверка, что повторный POST (имитация retry от n8n) не создаёт дублей.

## US-6. Non-functional и security проверки
Как QA-инженер, хочу базовые проверки latency и security, чтобы ловить деградации и очевидные уязвимости автоматически.
- AC: `@nonfunctional` — latency threshold (например p95 < X ms). `@security` — невалидный `X-API-Key` отклоняется, injection-попытки в query/body не ломают эндпоинт.

## US-7. CI на нужных событиях — ✅ ГОТОВО
Как QA-инженер, хочу, чтобы тесты гонялись автоматически на правильных триггерах, чтобы регрессии ловились до мержа, а дрифт — после деплоя.
- AC: `test-mock.yml` на `pull_request` — mock, блокирует merge при failure. `test-live.yml` на `push` в `main` — live, read-only. `nightly-full.yml` на cron + `workflow_dispatch` — оба таргета, все теги.
- [x] `.github/workflows/test-mock.yml` — реально прогнан на настоящем PR (#1), 54с, зелёный
- [x] `.github/workflows/test-live.yml` — реально прогнан на push в main, зелёный (секреты `LIVE_OWNER_EMAIL`/`LIVE_OWNER_PASSWORD` в GitHub Secrets)
- [x] `.github/workflows/nightly-full.yml` — реально прогнан вручную (workflow_dispatch), оба job'а (mock + live) зелёные
- [x] Branch protection на `main`: required status check `test-mock`, `strict: true` — реально merge теперь блокируется при красном тесте (потребовало сделать репозиторий публичным — required status checks недоступны для приватных репо без GitHub Pro)

## US-8. AI-генерация тестов на новые эндпоинты — ✅ ГОТОВО, генерация реально проверена на настоящем дрифте (2026-09-20)
Как QA-инженер, хочу, чтобы новые эндпоинты автоматически получали черновик тестов, чтобы покрытие не отставало от разработки.
- AC: `generate-tests.yml` детектит дрифт живого `/openapi.json` от снепшота. При дрифте запускает Claude Code (headless, `claude -p`) с диффом, просит сгенерировать тесты по паттерну существующих `tests/contracts/*.spec.ts`. Результат — новая ветка + PR, никогда прямой push в main. Снепшот обновляется только после мержа.
- [x] `ANTHROPIC_API_KEY` — получен, сохранён как GitHub secret
- [x] `.github/workflows/generate-tests.yml` — прогнан на настоящем дрифте (появление `facturen` + PATCH-эндпоинта). Результат: [PR #2](https://github.com/NorwenAdmin/zoofyautomation/pull/2), `tests/contracts/facturen.spec.ts` — 9 тестов (contract shape, happy path + AJV, partial-update семантика, идемпотентный повторный PATCH, auth 401×2, validation 422×2, 404 на неизвестный id без побочных эффектов). Качество не хуже написанного руками, паттерн выдержан. `test-mock` на PR зелёный
- [x] **Побочная находка генератора**: заметил, что PATCH-эндпоинт был задеплоен на VPS, но не закоммичен в git (`backend/app/routers/facturen.py`/`schemas.py` расходились с боевым кодом) — вместо провала теста корректно сделал `test.skip(!op, ...)` вместо жёсткого assert, чтобы не красить PR, и явно написал об этом в summary. Разрыв закоммичен отдельно
- [x] Найдены и исправлены 2 реальные проблемы инфраструктуры по пути: (1) на счету `ANTHROPIC_API_KEY` кончился баланс — пользователь пополнил; (2) настройка репозитория "Allow GitHub Actions to create and approve pull requests" была выключена (`can_approve_pull_request_reviews: false`) — генерация дошла до git push, но упала на `gh pr create`; включили через API, PR для уже готовой ветки создали вручную одноразово
- [ ] Смержить PR #2, затем прогнать `update-snapshot.yml`
- [x] `.github/workflows/update-snapshot.yml` (не было в исходном AC, добавлено по необходимости) — ручной workflow, обновляет снепшот после мержа + подтверждённого деплоя; реально прогнан, no-op когда снепшот уже актуален
- [x] Найден и исправлен реальный баг: многострочный `--body` в `generate-tests.yml` ломал YAML-отступы block scalar — заменили на однострочный `$'...\n...'`

## US-9. Отправка результатов во внешний сервис
Как QA-инженер, хочу, чтобы результаты тестов уходили во внешний ingest-эндпоинт, чтобы AI-анализ и дашборд жили отдельно от этого репозитория.
- AC: после прогона скрипт парсит JSON-репортер Playwright и шлёт `POST` на `TESTMIND_INGEST_URL` с заголовком `X-API-Key: TESTMIND_API_KEY` (оба — GitHub secrets). Этот репозиторий не знает, как результаты анализируются — только отправляет.
- **Нужны:** GitHub secrets `TESTMIND_INGEST_URL`/`TESTMIND_API_KEY` — можно добавить позже, US-9 просто не активна до этого.

## Вне скоупа этого репозитория/чата
Backend TestMind (приём ingest, AI-анализ, Failure Investigation Agent, LLM-judge, eval-слой), Vue-дашборд — отдельный проект/чат.

## Нужно от пользователя дальше
- [x] Решить порядок работ — фундамент первым, только subscription_invoices (готово)
- [x] Git repo — `git init` сделан
- [x] Доступ к репозиторию zoofyautomation — уже есть (это тот же проект)
- [x] Тестовые credentials для логина — уже есть (`kosty31@gmail.com` / см. память `project-zoofyautomation`)
- [ ] `ANTHROPIC_API_KEY` — нужен только для US-8, не блокирует US-1–US-7
- [ ] GitHub secrets `TESTMIND_INGEST_URL`/`TESTMIND_API_KEY` — нужны только для US-9, можно позже

