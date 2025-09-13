# Plano de Ação – Agente Perso

Este plano organiza as próximas entregas do agente Perso e serve como referência viva do projeto. Atualize conforme avançarmos.

## 1. Funcionalidades Prioritárias

### 1.1 Reconhecimento Multimodal
- Imagens: integrar Responses API da OpenAI para leitura/interpretação de imagens.
- Áudio: suporte a transcrição (STT) + interpretação semântica.
- Documentos: leitura e processamento de PDFs e arquivos (consulta de informações).

Ação:
- Criar módulos: `image_input/`, `audio_input/`, `doc_input/`.
- Expor endpoints para cada modalidade e rotas internas no Worker.

### 1.2 Pesquisa de Onboarding
- Perguntas obrigatórias:
  1) Objetivo principal
  2) Onde irá treinar
  3) Há quanto tempo treina

Ação:
- Orquestrar envio via Meta API (n8n): template de boas‑vindas → acesso → sequência da pesquisa.
- Salvar respostas no banco (Supabase).

### 1.3 Base de Conhecimento
- Upload/ingestão de PDFs e materiais de apoio.
- Grounding com Responses API nas consultas do agente.

Ação:
- Implementar `knowledge_base_handler` (ingestão + busca).
- Indexador vetorial (pgvector/Qdrant/Pinecone – decidir): camada de busca semântica.
- Integrar ao fluxo de conversas.

### 1.4 Tarefas e Agendamentos
- Usuário informa calendário (ex.: seg/qua/sex).
- Armazenar e verificar diariamente tarefas agendadas.
- Enviar lembretes automáticos no dia do treino.

Ação:
- Serviço `task_scheduler` (cron/queues). Em Workers: usar Scheduled events ou Cron Triggers.
- Persistir calendário e status no banco.

### 1.5 Follow‑ups Automáticos
- 3 dias sem interação → mensagem de engajamento.
- Verificação semanal de acesso ao app; se não acessou, marcar follow‑up.

Ação:
- `user_activity_checker` com triggers (cron) + templates de reengajamento.

### 1.6 Criação de Documentos (Futuro)
- Geração de fichas de treino personalizadas.
- Extração de treinos a partir de aulas do Weburn.

Ação (futuro):
- Mapear dados → gerar PDF com template.

---

## 2. Fluxo de Onboarding Detalhado
1) Webhook de compra recebido no Worker → cria tarefa de onboard.
2) Mensagens (Meta API via n8n):
   - 1ª: Boas‑vindas (template utilidade)
   - 2ª: Acesso
   - 3ª: Pesquisa (objetivo/local/tempo)
3) Validação: ao concluir pesquisa, liberar Perso completo e salvar respostas para personalização.

---

## 3. Estrutura Técnica Recomendada
- Worker (Cloudflare): centraliza webhooks, tools e orquestração (OpenAI + Supabase + n8n).
- Banco (Supabase/Postgres):
  - `conversation_history(conversation_id, role, content, created_at)` (já em uso)
  - `onboarding_answers(user_id, goal, location, training_time, created_at)`
  - `training_schedule(user_id, days[], timezone, created_at)`
  - `user_activity(user_id, last_seen_at, last_app_access_at)`
- n8n: rotas `tool/send-whatsapp`, fluxo de “humanização”, onboarding (templates Meta) e futuras ferramentas.

---

## 4. Próximos Passos Imediatos (M0/M1)
- [ ] Criar módulos `image_input/`, `audio_input/`, `doc_input/` (skeleton + rotas internas)
- [ ] Configurar endpoints Meta (n8n): boas‑vindas, acesso, pesquisa (3 perguntas)
- [ ] Estruturar `knowledge_base_handler` (ingestão de PDFs – stub)
- [ ] Implementar `task_scheduler` (cron) e `user_activity_checker` (cron) – stubs
- [ ] Validar onboarding E2E no Worker (POST) e n8n (envio + coleta)

Entregáveis mínimos:
- Rotas: `GET /health` (pronto), `POST /multimodal/*` (stubs), `POST /onboarding/*` (stubs)
- Tabelas Supabase criadas para onboarding/schedule/activity
- Fluxos n8n para onboarding funcionando em produção

---

## 5. Design de APIs (proposta)

Worker
- `GET /health` → status das VARS e config (implementado)
- `POST /multimodal/image` → { conversationId, imageUrl|base64, prompt? }
- `POST /multimodal/audio` → { conversationId, audioUrl|base64, prompt? }
- `POST /multimodal/doc` → { conversationId, fileUrl|base64, question }
- `POST /onboarding/start` → { userId, phone, orderId }
- `POST /onboarding/answer` → { userId, questionId, answer }
- `POST /schedule/set` → { userId, days[], tz }

n8n
- `POST /tool/send-whatsapp` (já)
- `POST /tool/buscar-programas` (opcional, hoje direto no Worker)
- Fluxo de onboarding (templates + coleta de respostas)

---

## 6. Métricas e Observabilidade
- Logs de tool‑calls (já temos `console.log`). Avaliar envio para Logpush/Analytics Engine.
- Métricas: taxa de conclusão do onboarding, engajamento (mensagens enviadas/lidas), conversões por sugestão do Perso.

---

## 7. Checklist de Configuração
- Vars no Worker (Production e Preview):
  - `OPENAI_API_KEY` (secret)
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `N8N_WEBHOOK_URL` (sem barra final)
  - `N8N_API_KEY`
  - `WEBURN_API_URL` (opcional, já com default)
- n8n: fluxo `tool/send-whatsapp` usando `$json.body.to` como destinatário; chave de API conferida.

---

## 8. Roadmap por Marcos
- M0: Saúde do Worker (/health), buscar_programas direto (entregue), config Wrangler (entregue)
- M1: Onboarding via n8n (boas‑vindas + acesso + pesquisa) + persistência no Supabase
- M2: Multimodal (image/audio/doc) – stubs e depois funcionalidades
- M3: Knowledge Base + busca semântica
- M4: Tarefas (schedule) + Follow‑ups (cron)
- M5: Geração de documentos (PDF)

---

## 9. Testes
- Unit (Vitest):
  - tool‑calls, erros de env, health check
  - multimodal handlers (stubs) com mocks
- Integração: 
  - Worker ↔ n8n (webhooks)
  - Worker ↔ Supabase (RPC/insert)
  - Worker ↔ Weburn API

---

## 10. Riscos e Mitigações
- Variáveis de ambiente divergentes entre Preview/Production → padronizar e validar via `/health`.
- Dependência de n8n para WhatsApp: manter contrato estável e normalizar base URL no Worker (feito).
- Latência nas tool‑calls → timeouts + retries controlados.

---

Atualize este arquivo a cada avanço.

