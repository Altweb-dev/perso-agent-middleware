import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// Env tipado
export interface Env {
  OPENAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  N8N_WEBHOOK_URL: string; // ex.: https://webhooks.altweb.ai/webhook  (com ou sem /webhook — tratamos abaixo)
  N8N_API_KEY: string;
}

// Modelo do histórico
interface ConversationMessage {
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

// ---------- Helpers comuns ----------
type SendResult = { ok: boolean; message_id?: string; error?: { code: string; detail?: string } };

const trunc = (s?: string, n = 1024) => (s ?? '').slice(0, n);
const trunc20 = (s?: string) => trunc(s, 20);
const trunc24 = (s?: string) => trunc(s, 24);
const trunc60 = (s?: string) => trunc(s, 60);
const trunc72 = (s?: string) => trunc(s, 72);

const normPhone = (to: string) => {
  const digits = (to || '').replace(/\D/g, '');
  if (!digits) return to;
  return digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
};

// Garante base com /webhook no fim
function getWebhookBase(env: Env) {
  const base = (env.N8N_WEBHOOK_URL || '').replace(/\/+$/, '');
  return base.endsWith('/webhook') ? base : `${base}/webhook`;
}

// ---------- Adapter WhatsApp → n8n ----------
async function postToSendWhatsappWebHook(env: Env, body: unknown, traceId: string): Promise<SendResult> {
  const url = `${getWebhookBase(env)}/tool/send-whatsapp`;
  console.log('send-whatsapp →', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': crypto.randomUUID(),
      'x-trace-id': traceId,
      'x-n8n-api-key': env.N8N_API_KEY, // n8n lê em lowercase
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('send-whatsapp webhook error', res.status, text);
    return { ok: false, error: { code: `HTTP_${res.status}`, detail: text } };
  }
  return { ok: true };
}

// Tools de envio
async function tool_send_whatsapp_text(
  env: Env,
  args: { to: string; text: string; reply_to?: string },
  traceId: string
) {
  const payload = {
    to: normPhone(args.to),
    message_type: 'text' as const,
    payload: { text: trunc(args.text), reply_to: args.reply_to },
  };
  return postToSendWhatsappWebHook(env, payload, traceId);
}

async function tool_send_whatsapp_buttons(
  env: Env,
  args: { to: string; body: string; buttons: { id: string; text: string }[]; header?: string; footer?: string },
  traceId: string
) {
  const interactive = {
    type: 'button',
    header: args.header ? { type: 'text', text: trunc60(args.header) } : undefined,
    body: { text: trunc(args.body) },
    footer: args.footer ? { text: trunc60(args.footer) } : undefined,
    action: {
      buttons: (args.buttons || [])
        .slice(0, 3)
        .map((b) => ({ type: 'reply', reply: { id: b.id, title: trunc20(b.text) } })),
    },
  };
  const body = { to: normPhone(args.to), message_type: 'interactive' as const, payload: interactive };
  return postToSendWhatsappWebHook(env, body, traceId);
}

async function tool_send_whatsapp_list(
  env: Env,
  args: {
    to: string;
    body: string;
    header?: string;
    footer?: string;
    button: string;
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
  },
  traceId: string
) {
  const interactive = {
    type: 'list',
    header: args.header ? { type: 'text', text: trunc60(args.header) } : undefined,
    body: { text: trunc(args.body) },
    footer: args.footer ? { text: trunc60(args.footer) } : undefined,
    action: {
      button: trunc20(args.button),
      sections: (args.sections || []).slice(0, 10).map((s) => ({
        title: trunc24(s.title),
        rows: (s.rows || []).slice(0, 10).map((r) => ({
          id: r.id,
          title: trunc24(r.title),
          description: r.description ? trunc72(r.description) : undefined,
        })),
      })),
    },
  };
  const body = { to: normPhone(args.to), message_type: 'interactive' as const, payload: interactive };
  return postToSendWhatsappWebHook(env, body, traceId);
}

// ---------- Worker ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Método não permitido', { status: 405 });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

    // executor genérico para outras ferramentas n8n (ex.: buscar-programas)
    const executeTool = async (toolName: string, args: any): Promise<string> => {
      try {
        const base = getWebhookBase(env);
        const url = `${base}/tool/${toolName}`;
        console.log('executeTool:', toolName, '→', url);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-n8n-api-key': env.N8N_API_KEY,
          },
          body: JSON.stringify(args),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.error(`executeTool ${toolName} HTTP_${response.status}:`, errorText);
          return `Erro na ferramenta ${toolName}: ${response.statusText}`;
        }

        const result = await response.json().catch(() => ({}));
        return JSON.stringify(result);
      } catch (error) {
        console.error(`Erro ao executar ${toolName}:`, error);
        return `Erro interno na ferramenta: ${error instanceof Error ? error.message : 'Erro desconhecido'}`;
      }
    };

    try {
      // Agora aceitamos userPhone (opcional) para injetar 'to' automaticamente
      const { conversationId, newMessage, userPhone, platform } = await request.json<{
        conversationId: string;
        newMessage: string;
        userPhone?: string; // ex.: +55…
        platform?: string;  // ex.: "whatsapp"
      }>();

      if (!conversationId || !newMessage) {
        return new Response('Os campos "conversationId" e "newMessage" são obrigatórios.', { status: 400 });
      }

      // 1) Salvar msg do usuário
      const { error: insertError } = await supabase
        .from('conversation_history')
        .insert([{ conversation_id: conversationId, role: 'user', content: newMessage }]);
      if (insertError) throw new Error(`Erro ao salvar mensagem do usuário: ${insertError.message}`);

      // 2) Buscar histórico
      const { data: history, error: rpcError } = (await supabase.rpc('get_conversation_history', {
        p_conversation_id: conversationId,
        p_limit: 20,
      })) as { data: ConversationMessage[] | null; error: any };
      if (rpcError) throw new Error(`Erro ao buscar histórico: ${rpcError.message}`);

      // 3) Mensagens para o modelo
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `Você é o Perso, agente Weburn (fitness/nutri) no WhatsApp.

Estilo:
- Amigável, motivacional e direto; respostas curtas e úteis.
- Não repita mensagens já enviadas pela Meta; use o histórico como contexto.
- Normalize entradas como 1/2/3 ou a/b/c para valores canônicos.

Ferramentas (quando usar):
- buscar_programas_weburn: sugerir programas conforme nível/modalidade/equipamentos.
- send_whatsapp_text: confirmações/avisos curtos.
- send_whatsapp_buttons: até 3 opções curtas.
- send_whatsapp_list: listas maiores/categorizadas.

Regras:
- Apenas 1 ferramenta por resposta. Em erro, responda em texto com opções numeradas.`,
        },
      ];

      if (history && history.length > 0) {
        for (const msg of history) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({ role: msg.role, content: msg.content });
          }
        }
      }

      // 4) Tools expostas ao modelo
      const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'buscar_programas_weburn',
            description: 'Busca programas de treino na plataforma Weburn com base no nível, modalidade e disponibilidade de equipamentos.',
            parameters: {
              type: 'object',
              properties: {
                nivel: { type: 'string', description: 'Nível do usuário (Iniciante, Intermediário, Avançado)' },
                modalidade: { type: 'string', description: 'Modalidade de treino (ex.: HIIT, Yoga, Musculação, etc.)' },
                possui_equipamentos: { type: 'boolean', description: 'Se o usuário possui equipamentos em casa' },
              },
              required: ['nivel', 'modalidade', 'possu i_equipamentos'.replace(' ', '')], // mantém nomes iguais aos esperados no seu n8n
              additionalProperties: false,
            },
          },
        },
        // Legado
        {
          type: 'function',
          function: {
            name: 'send_whatsapp',
            description: 'LEGADO: envia uma mensagem de texto simples via WhatsApp.',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Telefone E.164: +55...' },
                text: { type: 'string', description: 'Mensagem curta (<= 1024 chars)' },
                reply_to: { type: 'string', description: 'Opcional: message_id para reply' },
              },
              required: ['to', 'text'],
              additionalProperties: false,
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'send_whatsapp_text',
            description: 'Envia mensagem de texto simples pelo WhatsApp.',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Telefone E.164: +55...' },
                text: { type: 'string', description: 'Mensagem curta (<= 1024 chars)' },
                reply_to: { type: 'string', description: 'Opcional: message_id para reply' },
              },
              required: ['to', 'text'],
              additionalProperties: false,
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'send_whatsapp_buttons',
            description: 'Envia mensagem interativa com até 3 botões (reply).',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                body: { type: 'string' },
                buttons: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 3,
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' }, text: { type: 'string', description: 'Rótulo curto (~20 chars)' } },
                    required: ['id', 'text'],
                    additionalProperties: false,
                  },
                },
                header: { type: 'string' },
                footer: { type: 'string' },
              },
              required: ['to', 'body', 'buttons'],
              additionalProperties: false,
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'send_whatsapp_list',
            description: 'Envia lista interativa (seções/linhas).',
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                body: { type: 'string' },
                header: { type: 'string' },
                footer: { type: 'string' },
                button: { type: 'string', description: 'Texto do botão principal' },
                sections: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 10,
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      rows: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 10,
                        items: {
                          type: 'object',
                          properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
                          required: ['id', 'title'],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ['title', 'rows'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['to', 'body', 'button', 'sections'],
              additionalProperties: false,
            },
          },
        },
      ];

      // Helper: injeta 'to' se ausente (usa userPhone vindo do n8n)
      const withTo = <T extends { to?: string }>(args: T) => {
        const to = args?.to || userPhone || '';
        return { ...args, to };
      };

      // 5) Chamar OpenAI
      let agentResponse = '';
      let toolCallsExecuted = 0;

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 1000,
        });

        const assistantMessage = completion.choices[0].message;

        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          console.log('Executando tool calls:', assistantMessage.tool_calls.length);
          messages.push(assistantMessage);

          for (const toolCall of assistantMessage.tool_calls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments || '{}');

            let toolResult = '';

            if (functionName === 'buscar_programas_weburn') {
              toolResult = await executeTool('buscar-programas', functionArgs);
            } else if (functionName === 'send_whatsapp' || functionName === 'send_whatsapp_text') {
              const r = await tool_send_whatsapp_text(env, withTo(functionArgs), crypto.randomUUID());
              toolResult = JSON.stringify(r);
            } else if (functionName === 'send_whatsapp_buttons') {
              const r = await tool_send_whatsapp_buttons(env, withTo(functionArgs), crypto.randomUUID());
              toolResult = JSON.stringify(r);
            } else if (functionName === 'send_whatsapp_list') {
              const r = await tool_send_whatsapp_list(env, withTo(functionArgs), crypto.randomUUID());
              toolResult = JSON.stringify(r);
            } else {
              toolResult = `Tool não implementada: ${functionName}`;
            }

            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
            toolCallsExecuted++;
          }

          const finalCompletion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: 1000,
          });

          agentResponse = finalCompletion.choices[0].message.content || 'Desculpe, não consegui gerar uma resposta.';
        } else {
          agentResponse = assistantMessage.content || 'Desculpe, não consegui gerar uma resposta.';
        }
      } catch (openaiError) {
        console.error('Erro na API da OpenAI:', openaiError);
        agentResponse = 'Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.';
      }

      // 6) Salvar resposta do assistente
      const { error: assistantInsertError } = await supabase.from('conversation_history').insert([
        { conversation_id: conversationId, role: 'assistant', content: agentResponse },
      ]);
      if (assistantInsertError) console.error('Erro ao salvar resposta do assistente:', assistantInsertError);

      // 7) Retornar
      return new Response(
        JSON.stringify({
          success: true,
          conversationId,
          response: agentResponse,
          metadata: {
            messagesInHistory: (history || []).length,
            toolCallsExecuted,
            timestamp: new Date().toISOString(),
            platform: platform || 'unknown',
            userPhone: userPhone || null,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e: any) {
      console.error('Erro no Worker:', e);
      return new Response(`Erro interno no agente: ${e.message}`, { status: 500 });
    }
  },
};
