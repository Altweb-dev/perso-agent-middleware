import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// Define a interface para as variáveis de ambiente para ter tipagem segura
export interface Env {
	OPENAI_API_KEY: string;
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	N8N_WEBHOOK_URL: string;
	N8N_API_KEY: string;
}

// Interface para o histórico de conversa do Supabase
interface ConversationMessage {
	conversation_id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	created_at: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Método não permitido', { status: 405 });
		}

		// Inicializar clientes
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
		const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

		// Função auxiliar para executar ferramentas no n8n
		const executeTool = async (toolName: string, args: any): Promise<string> => {
			try {
				console.log(`Executando ferramenta ${toolName}:`, args);
				
				const response = await fetch(`${env.N8N_WEBHOOK_URL}/tool/${toolName}`, {
					method: 'POST',
					headers: { 
						'Content-Type': 'application/json', 
						'X-N8N-API-KEY': env.N8N_API_KEY 
					},
					body: JSON.stringify(args),
				});
				
				if (!response.ok) {
					const errorText = await response.text();
					console.error(`Erro na ferramenta ${toolName}:`, response.status, errorText);
					return `Erro na ferramenta ${toolName}: ${response.statusText}`;
				}
				
				const result = await response.json();
				console.log(`Resultado da ferramenta ${toolName}:`, result);
				return JSON.stringify(result);
			} catch (error) {
				console.error(`Erro ao executar ${toolName}:`, error);
				return `Erro interno na ferramenta: ${error instanceof Error ? error.message : 'Erro desconhecido'}`;
			}
		};

		// --- Lógica Principal do Worker ---
		try {
			const { conversationId, newMessage } = await request.json<{ conversationId: string; newMessage: string }>();
			if (!conversationId || !newMessage) {
				return new Response('Os campos "conversationId" e "newMessage" são obrigatórios.', { status: 400 });
			}

			// 1. Salvar a nova mensagem do usuário no histórico
			const { error: insertError } = await supabase.from('conversation_history').insert([
                { conversation_id: conversationId, role: 'user', content: newMessage },
            ]);
            if (insertError) throw new Error(`Erro ao salvar mensagem do usuário: ${insertError.message}`);


			// 2. Buscar o histórico recente da conversa
			const { data: history, error: rpcError } = await supabase.rpc('get_conversation_history', {
				p_conversation_id: conversationId,
				p_limit: 20,
			}) as { data: ConversationMessage[] | null; error: any };
			if (rpcError) throw new Error(`Erro ao buscar histórico: ${rpcError.message}`);

			console.log('Histórico recuperado:', (history || []).length, 'mensagens');

			// 3. Preparar mensagens para a OpenAI
			const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
				{
					role: 'system',
					content: `Você é o Perso, um agente da Weburn especializado em fitness e bem-estar.

Sua personalidade:
- Amigável, motivador e conhecedor de fitness
- Responde de forma concisa mas informativa
- Sempre pronto para ajudar com programas de treino e dicas de saúde
- Use as ferramentas disponíveis quando necessário

Diretrizes:
- Mantenha as respostas focadas e úteis
- Se precisar buscar programas, use a ferramenta buscar_programas_weburn
- Quando solicitado para enviar informações via WhatsApp, use a ferramenta send_whatsapp
- Seja proativo em sugerir programas adequados ao perfil do usuário`
				}
			];

			// Adicionar histórico de mensagens
			if (history && history.length > 0) {
				for (const msg of history) {
					if (msg.role === 'user' || msg.role === 'assistant') {
						messages.push({
							role: msg.role,
							content: msg.content
						});
					}
				}
			}

			// Definir ferramentas disponíveis
			const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
				{
					type: 'function',
					function: {
						name: 'buscar_programas_weburn',
						description: 'Busca programas de treino na plataforma Weburn com base no nível, modalidade e disponibilidade de equipamentos.',
						parameters: {
							type: 'object',
							properties: {
								nivel: { 
									type: 'string',
									description: 'Nível do usuário (iniciante, intermediário, avançado)'
								},
								modalidade: { 
									type: 'string',
									description: 'Modalidade de treino (musculação, cardio, funcional, etc.)'
								},
								possui_equipamentos: { 
									type: 'boolean',
									description: 'Se o usuário possui equipamentos em casa'
								},
							},
							required: ['nivel', 'modalidade', 'possui_equipamentos'],
						}
					}
				},
				{
					type: 'function',
					function: {
						name: 'send_whatsapp',
						description: 'Envia uma mensagem de texto para o usuário via WhatsApp.',
						parameters: {
							type: 'object',
							properties: {
								to: { 
									type: 'string',
									description: 'Número de telefone do destinatário no formato internacional'
								},
								text: { 
									type: 'string',
									description: 'Texto da mensagem a ser enviada'
								},
							},
							required: ['to', 'text'],
						}
					}
				}
			];

			// 4. Chamar a API da OpenAI
			let agentResponse = '';
			let toolCallsExecuted = 0;
			
			try {
				const completion = await openai.chat.completions.create({
					model: 'gpt-4o-mini',
					messages: messages,
					tools: tools,
					tool_choice: 'auto',
					temperature: 0.7,
					max_tokens: 1000,
				});

				const assistantMessage = completion.choices[0].message;

				// Verificar se há tool calls para executar
				if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
					console.log('Executando tool calls:', assistantMessage.tool_calls.length);
					
					// Adicionar a mensagem do assistente com tool calls
					messages.push(assistantMessage);

					// Executar cada tool call
					for (const toolCall of assistantMessage.tool_calls) {
						const functionName = toolCall.function.name;
						const functionArgs = JSON.parse(toolCall.function.arguments);
						
						console.log(`Executando função: ${functionName}`, functionArgs);
						
						let toolResult = '';
						if (functionName === 'buscar_programas_weburn') {
							toolResult = await executeTool('buscar-programas', functionArgs);
						} else if (functionName === 'send_whatsapp') {
							toolResult = await executeTool('send-whatsapp', functionArgs);
						}
						
						// Adicionar resultado da ferramenta
						messages.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							content: toolResult
						});
						
						toolCallsExecuted++;
					}

					// Fazer nova chamada para obter a resposta final
					const finalCompletion = await openai.chat.completions.create({
						model: 'gpt-4o-mini',
						messages: messages,
						temperature: 0.7,
						max_tokens: 1000,
					});

					agentResponse = finalCompletion.choices[0].message.content || 'Desculpe, não consegui gerar uma resposta.';
				} else {
					// Resposta direta sem tool calls
					agentResponse = assistantMessage.content || 'Desculpe, não consegui gerar uma resposta.';
				}

				console.log('Resposta do agente gerada:', agentResponse);
				console.log('Tool calls executados:', toolCallsExecuted);

			} catch (openaiError) {
				console.error('Erro na API da OpenAI:', openaiError);
				agentResponse = 'Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes.';
			}

			// 5. Salvar a resposta do assistente no histórico
			const { error: assistantInsertError } = await supabase
				.from('conversation_history')
				.insert([
					{ 
						conversation_id: conversationId, 
						role: 'assistant', 
						content: agentResponse 
					},
				]);

			if (assistantInsertError) {
				console.error('Erro ao salvar resposta do assistente:', assistantInsertError);
				// Não falha a requisição, apenas loga o erro
			}

			console.log('Resposta do agente gerada com sucesso:', agentResponse);

			// 6. Retornar a resposta final
			return new Response(JSON.stringify({
				success: true,
				conversationId,
				response: agentResponse,
				metadata: {
					messagesInHistory: (history || []).length,
					toolCallsExecuted: toolCallsExecuted,
					timestamp: new Date().toISOString()
				}
			}), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (e: any) {
			console.error('Erro no Worker:', e);
			return new Response(`Erro interno no agente: ${e.message}`, { status: 500 });
		}
	},
};


