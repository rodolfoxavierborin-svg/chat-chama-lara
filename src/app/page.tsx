"use client";

import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Lead, Message } from '../types';

// Helper para formatar o horário de forma parecida com o WhatsApp
const formatarHorario = (dataIso: string | null | undefined) => {
  if (!dataIso) return '';
  const data = new Date(dataIso);
  const hoje = new Date();
  if (data.toDateString() === hoje.toDateString()) {
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
};

// Obtém o timestamp da última interação para ordenação
const getUltimaInteracao = (lead: any) => {
  const rawDate = lead.ultima_interacao || lead['última_interação'] || lead.created_at;
  return rawDate ? new Date(rawDate).getTime() : 0;
};

// Parse seguro de mensagens (trata strings simples ou JSONs gravados no banco)
const parseMensagem = (msg: any) => {
  let raw = msg.content !== undefined ? msg.content : (msg.message || msg);
  let type = msg.type || 'human';
  let content = '';

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        type = parsed.type || type;
        content = parsed.content || parsed.data?.content || raw;
      } else {
        content = raw;
      }
    } catch (e) {
      content = raw;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    type = raw.type || type;
    content = raw.content || raw.data?.content || '';
    if (typeof content === 'object') {
      try { content = JSON.stringify(content); } catch (e) { content = ''; }
    }
  }

  return { type, content, isTool: type === 'tool' };
};

// Filtro de mensagens técnicas de sistema/ferramentas
const isMensagemTecnica = (msg: any): boolean => {
  const { content, isTool } = parseMensagem(msg);
  if (isTool) return true;
  if (!content || typeof content !== 'string') return false;
  const t = content.trim();
  if (t.startsWith('Calling ') || t.includes('with input:')) return true;
  if (t.includes('Confirmar_Agendamento') || t.includes('Create_an_event') || t.includes('Call_Sub-workflow')) return true;
  return false;
};

const ChatPage = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Rolagem automática para a última mensagem
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // 1. Buscando Leads e aplicando Realtime Global
  useEffect(() => {
    const fetchLeads = async () => {
      setLoadingLeads(true);
      const { data, error } = await supabase
        .from('leads')
        .select('*');

      if (error) {
        console.error('Erro ao buscar leads:', error);
      } else {
        const fetchedLeads = data || [];
        setLeads(fetchedLeads);
        if (fetchedLeads.length > 0 && !selectedLead) {
          // Seleciona por padrão o lead com a interação mais recente
          const sorted = [...fetchedLeads].sort((a, b) => getUltimaInteracao(b) - getUltimaInteracao(a));
          setSelectedLead(sorted[0]);
        }
      }
      setLoadingLeads(false);
    };

    fetchLeads();

    // Escuta alterações na tabela de leads
    const leadsChannel = supabase
      .channel('leads-global-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads' },
        (payload: any) => {
          const newLead = payload.new as Lead;
          if (!newLead || !newLead.id) return;

          setLeads((curr) => {
            const exists = curr.some((l) => l.id === newLead.id);
            if (exists) {
              return curr.map((l) => (l.id === newLead.id ? newLead : l));
            }
            return [newLead, ...curr];
          });

          setSelectedLead((prev) => (prev?.id === newLead.id ? newLead : prev));
        }
      )
      .subscribe();

    // Escuta novas mensagens para atualizar a data de interação do lead na sidebar
    const globalMessagesChannel = supabase
      .channel('global-messages-sidebar-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: any) => {
          const newMsg = payload.new;
          if (!newMsg || !newMsg.lead_id) return;

          setLeads((currLeads) =>
            currLeads.map((lead) => {
              if (lead.id === newMsg.lead_id) {
                return {
                  ...lead,
                  ultima_interacao: newMsg.created_at || new Date().toISOString(),
                };
              }
              return lead;
            })
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(leadsChannel);
      supabase.removeChannel(globalMessagesChannel);
    };
  }, []);

  // 2. Buscando Mensagens do Lead selecionado em Tempo Real
  useEffect(() => {
    if (!selectedLead) return;

    const fetchMessages = async () => {
      setLoadingMessages(true);
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('lead_id', selectedLead.id)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Erro ao buscar mensagens:', error);
      } else {
        setMessages(data || []);
      }
      setLoadingMessages(false);
    };

    fetchMessages();

    const messagesChannel = supabase
      .channel('chat_messages_realtime_' + selectedLead.id)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: any) => {
          const newMsg = payload.new as Message;
          if (newMsg && newMsg.lead_id === selectedLead.id) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;

              // Substitui mensagem temporária otimista se existir
              const tempIndex = prev.findIndex((m) => String(m.id).startsWith('temp-'));
              if (tempIndex !== -1) {
                const updated = [...prev];
                updated[tempIndex] = newMsg;
                return updated;
              }

              return [...prev, newMsg];
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(messagesChannel);
    };
  }, [selectedLead?.id]);

  // Função para pausar/despausar a IA
  const togglePauseAI = async () => {
    if (!selectedLead) return;

    const newStatus = !selectedLead.is_paused;
    const updatedLead = { ...selectedLead, is_paused: newStatus };

    setSelectedLead(updatedLead);
    setLeads((prev) => prev.map((l) => (l.id === selectedLead.id ? updatedLead : l)));

    const { error } = await supabase
      .from('leads')
      .update({ is_paused: newStatus })
      .eq('id', selectedLead.id);

    if (error) {
      console.error('Erro ao alternar pausa da IA:', error);
    }
  };

  // Enviar mensagem do Atendente Humano
  const handleSendMessage = async () => {
    if (newMessage.trim() === '' || !selectedLead) return;

    const messageText = newMessage;
    setNewMessage('');

    // Adiciona mensagem otimista no estado
    const tempId = 'temp-' + Date.now();
    const optimisticMessage: any = {
      id: tempId,
      lead_id: selectedLead.id,
      type: 'human_agent',
      content: messageText,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      // Se a IA não estiver pausada, pausa automaticamente ao atendente responder
      if (!selectedLead.is_paused) {
        const leadPausado = { ...selectedLead, is_paused: true };
        setSelectedLead(leadPausado);
        setLeads((prev) => prev.map((l) => (l.id === selectedLead.id ? leadPausado : l)));
        await supabase.from('leads').update({ is_paused: true }).eq('id', selectedLead.id);
      }

      const { data: insertedMessage, error: dbError } = await supabase
        .from('messages')
        .insert({
          lead_id: selectedLead.id,
          type: 'human_agent',
          content: messageText,
        })
        .select()
        .single();

      if (dbError) {
        console.error('Erro ao salvar mensagem:', dbError);
        return;
      }

      if (insertedMessage) {
        setMessages((prev) =>
          prev.map((msg) => (msg.id === tempId ? insertedMessage : msg))
        );
      }

      // Dispara o webhook para envio no WhatsApp via API
      fetch('https://api.rodolfoxborin.com.br/webhook/crm-envio-humano', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: selectedLead.id,
          phone_number: selectedLead.phone_number,
          content: messageText,
          message_id: insertedMessage?.id || tempId,
        }),
      }).catch((err) => console.error('Erro ao disparar webhook:', err));

    } catch (error) {
      console.error('Erro geral ao enviar mensagem:', error);
    }
  };

  // Ordenação dos leads pela última interação
  const sortedLeads = [...leads].sort((a, b) => getUltimaInteracao(b) - getUltimaInteracao(a));

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans notranslate" translate="no">
      
      {/* HEADER PRINCIPAL */}
      <div className="bg-white border-b border-slate-200 px-4 md:px-6 h-14 md:h-16 shrink-0 flex items-center justify-between z-20 shadow-sm">
        <div className="flex items-center gap-3">
          <h1 className="text-base md:text-lg font-bold text-slate-800">
            Chama Lara <span className="text-emerald-600 font-medium text-xs md:text-sm">| Atendimento WhatsApp</span>
          </h1>
        </div>
        <div className="text-xs text-slate-500 font-medium">
          Total de conversas: <span className="font-bold text-slate-800">{sortedLeads.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <div className="flex h-full w-full bg-white">
          
          {/* SIDEBAR DE CONVERSAS */}
          <div className={`w-full md:w-[380px] border-r border-slate-200 bg-white flex flex-col ${selectedLead ? 'hidden md:flex' : 'flex'}`}>
            <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center h-[52px] md:h-[56px] shrink-0">
              <h2 className="text-sm md:text-base font-bold text-slate-800">Mensagens Recentes</h2>
              <span className="text-xs bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 rounded-full">{sortedLeads.length}</span>
            </div>

            {loadingLeads ? (
              <div className="p-4 text-center text-xs text-slate-500">Carregando conversas...</div>
            ) : (
              <ul className="flex-1 overflow-y-auto bg-white custom-scrollbar">
                {sortedLeads.map((lead: any) => {
                  const ultimaInteracao = lead.ultima_interacao || lead['última_interação'] || lead.created_at;
                  const isSelected = selectedLead?.id === lead.id;
                  const photo = lead.avatar_url || lead.photo_url || lead.profile_pic;

                  return (
                    <li
                      key={lead.id}
                      onClick={() => setSelectedLead(lead)}
                      className={`cursor-pointer p-3 transition-all border-b border-slate-100 flex gap-3 items-center ${
                        isSelected ? 'bg-emerald-50/80 border-l-4 border-l-emerald-600' : 'hover:bg-slate-50'
                      }`}
                    >
                      {photo ? (
                        <img src={photo} alt={lead.name || 'Contato'} className="w-10 h-10 rounded-full object-cover shrink-0 shadow-sm" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-base shrink-0">
                          {lead.name ? lead.name.charAt(0).toUpperCase() : 'P'}
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-baseline mb-0.5">
                          <p className={`font-semibold text-sm truncate ${isSelected ? 'text-slate-900' : 'text-slate-800'}`}>
                            {lead.name || 'Sem Nome'}
                          </p>
                          <span className="text-[11px] text-slate-400 whitespace-nowrap ml-2">
                            {formatarHorario(ultimaInteracao)}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <p className="text-xs text-slate-500 truncate">{lead.phone_number || lead.phone}</p>
                          {lead.is_paused && (
                            <span className="bg-slate-800 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ml-2 shrink-0">
                              Humano
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ÁREA DO CHAT ESTILO WHATSAPP */}
          <div className={`flex-1 flex-col bg-[#EFEAE2] relative ${selectedLead ? 'flex' : 'hidden md:flex'}`}>
            <div 
              className="absolute inset-0 opacity-40 pointer-events-none" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/cubes.png")' }}
            ></div>

            {selectedLead ? (
              <>
                {/* HEADER DO CHAT */}
                <div className="bg-slate-50 border-b border-slate-200 px-4 h-[52px] md:h-[56px] shrink-0 flex justify-between items-center z-10">
                  <div className="flex items-center gap-3">
                    {/* Botão de Voltar para o Mobile */}
                    <button onClick={() => setSelectedLead(null)} className="md:hidden text-slate-600 pr-1 hover:text-slate-900">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>

                    {(selectedLead as any).avatar_url || (selectedLead as any).photo_url ? (
                      <img 
                        src={(selectedLead as any).avatar_url || (selectedLead as any).photo_url} 
                        alt={selectedLead.name || 'Paciente'} 
                        className="w-8 h-8 md:w-9 md:h-9 rounded-full object-cover shadow-sm" 
                      />
                    ) : (
                      <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-sm md:text-base">
                        {selectedLead.name ? selectedLead.name.charAt(0).toUpperCase() : 'P'}
                      </div>
                    )}

                    <div>
                      <h2 className="text-xs md:text-sm font-bold text-slate-800">{selectedLead.name || 'Sem Nome'}</h2>
                      <span className="text-[11px] md:text-xs text-slate-500">{selectedLead.phone_number}</span>
                    </div>
                  </div>

                  {/* BOTÃO TOGGLE IA PAUSADA / ATIVA */}
                  <button
                    onClick={togglePauseAI}
                    className={`px-3 py-1 md:px-4 md:py-1.5 rounded-lg font-bold text-xs transition-all border shadow-sm ${
                      selectedLead.is_paused 
                        ? 'bg-red-500 text-white border-red-600 hover:bg-red-600' 
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {selectedLead.is_paused ? '▶ Retomar IA' : '⏸️ Assumir Chat'}
                  </button>
                </div>

                {/* ÁREA DE MENSAGENS */}
                <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-3 relative z-10 custom-scrollbar">
                  {loadingMessages ? (
                    <div className="text-center text-xs text-slate-500 py-4">Carregando histórico...</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-xs text-slate-500 bg-white/90 p-3 rounded-lg max-w-xs mx-auto shadow-sm">
                      Nenhuma mensagem encontrada nesta conversa.
                    </div>
                  ) : (
                    messages.map((msg) => {
                      if (isMensagemTecnica(msg)) return null;

                      const { type, content } = parseMensagem(msg);

                      const isPatient = type === 'human' || type === 'user';
                      const isAI = type === 'ai' || type === 'assistant';

                      // Separa a mensagem por '###' para gerar múltiplos balões igual ao WhatsApp
                      const baloes = (content || '')
                        .split('###')
                        .map((t: string) => t.trim())
                        .filter((t: string) => t.length > 0);

                      return (
                        <React.Fragment key={msg.id}>
                          {baloes.map((texto: string, index: number) => (
                            <div key={`${msg.id}-${index}`} className={`flex ${isPatient ? 'justify-start' : 'justify-end'}`}>
                              <div
                                className={`max-w-[85%] md:max-w-md rounded-2xl p-3 shadow-sm relative ${
                                  isPatient
                                    ? 'bg-white text-slate-800 rounded-tl-none border border-slate-100/80'
                                    : 'bg-[#D9FDD3] text-slate-800 rounded-tr-none'
                                }`}
                              >
                                <span className={`block text-[11px] font-bold mb-1 ${
                                  isPatient ? 'text-slate-400' : isAI ? 'text-emerald-700' : 'text-emerald-800'
                                }`}>
                                  {isPatient ? 'Paciente' : isAI ? 'Chama Lara (IA)' : 'Você (Atendente)'}
                                </span>

                                <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{texto}</p>

                                <span className="block text-[10px] text-right mt-1.5 text-slate-400">
                                  {new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                            </div>
                          ))}
                        </React.Fragment>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* BARRA DE ENVIO DE MENSAGEM */}
                <div className="p-2.5 md:p-3 bg-slate-50 h-[58px] md:h-[64px] shrink-0 flex items-center z-10 border-t border-slate-200">
                  <div className="flex items-center space-x-2 w-full max-w-5xl mx-auto">
                    <div className="flex-1 bg-white rounded-full p-1 md:p-1.5 flex items-center shadow-sm border border-slate-300 focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500 transition-all">
                      <input
                        type="text"
                        placeholder="Digite uma mensagem..."
                        className="flex-1 bg-transparent px-3 py-1 text-sm text-slate-800 outline-none"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleSendMessage();
                          }
                        }}
                      />
                    </div>
                    <button
                      onClick={handleSendMessage}
                      className="bg-[#00A884] text-white w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center hover:bg-[#008f70] transition-colors shadow-sm shrink-0"
                      title="Enviar Mensagem"
                    >
                      <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
                      </svg>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* ESTADO VAZIO (Nenhum Lead Selecionado) */
              <div className="flex flex-1 items-center justify-center bg-[#EFEAE2] z-10">
                <div className="text-center bg-white p-6 rounded-2xl shadow-sm border border-slate-200 max-w-xs">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Chama Lara Inbox</h3>
                  <p className="text-xs text-slate-500">Selecione uma conversa à esquerda<br/>para visualizar e iniciar o atendimento.</p>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ESTILOS CUSTOMIZADOS DE SCROLLBAR */}
      <style dangerouslySetInnerHTML={{__html: '.custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 10px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94A3B8; }'}} />
    </div>
  );
};

export default ChatPage;