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
      .channel(`chat