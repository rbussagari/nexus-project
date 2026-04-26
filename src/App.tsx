import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, Key, Smartphone, CheckCircle2, XCircle, Lock, 
  Copy, RefreshCw, Terminal, Activity, Database, Laptop, Info,
  ExternalLink, Code, MessageSquare, MapPin, Radio, Users, Zap,
  Wifi, Bluetooth, QrCode, ArrowUpRight, Clock, Trash2, Send, Share2, Camera, X
} from 'lucide-react';
import { getIdentity, signMessage, verifySignature, Identity } from './lib/cryptoService';
import { 
  db, addMessage, getContacts, upsertContact, 
  Message, Contact, switchDatabaseNode
} from './lib/db';
import { processIncomingMessage, purgeExpiredData } from './lib/relayEngine';
import { generateSummaryVector, compareVectors, mergeMessages } from './lib/syncProtocol';
import { exportMessages, importMessages } from './lib/fileService';
import { chunkPayload, QRReassembler } from './lib/qrService';
import { ble } from './lib/bleService';
import { sendDirectMessage } from './lib/messagingService';
import { createDrop, scanDrop, getActiveDrops } from './lib/dropService';
import { addContact, updateLastSeen, updateTrustScore } from './lib/contactService';
import { QRChatProtocol } from './lib/qrChatService';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';

import { Login } from './components/Login';
import { adjustTrustScore, adjustReputation } from './lib/trustService';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [persona, setPersona] = useState<'alpha' | 'beta' | 'gamma' | 'delta'>('alpha');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [dbStatus, setDbStatus] = useState('OFFLINE_MESH');
  const [activeTab, setActiveTab] = useState<'messages' | 'drops' | 'sync' | 'contacts'>('messages');
  
  // Navigation State
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [relayFeedback, setRelayFeedback] = useState<{ success: boolean; reason: string } | null>(null);

  // DM State
  const [dmTarget, setDmTarget] = useState('');
  const [dmContent, setDmContent] = useState('');

  // Scanned Message Feedback
  const [scannedMessage, setScannedMessage] = useState<Message | null>(null);

  // Sync Demo State
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [qrMode, setQrMode] = useState<'none' | 'send' | 'receive' | 'drop' | 'live'>('none');
  const [qrChunks, setQrChunks] = useState<string[]>([]);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [lastScannedData, setLastScannedData] = useState<string | null>(null);

  // Optical Tunnel State
  const [opticalSession, setOpticalSession] = useState<{
    lastReceivedId: string | null;
    pendingAcks: string[];
    outbox: Message[];
  }>({
    lastReceivedId: null,
    pendingAcks: [],
    outbox: []
  });

  useEffect(() => {
    let scanner: Html5QrcodeScanner | null = null;
    if (qrMode === 'receive' || qrMode === 'live') {
      scanner = new Html5QrcodeScanner("reader", { 
        fps: 15, // Increased for smoother live sync
        qrbox: 250,
        aspectRatio: 1
      }, false);

      scanner.render(async (decodedText) => {
        if (decodedText === lastScannedData) return;
        setLastScannedData(decodedText);
        
        try {
          const data = JSON.parse(decodedText);
          
          // Pattern: Live Frame Handling (ACK System)
          if (data.type === 'live_frame') {
            const { payload, ackId, sender } = data;
            
            // 1. Handle incoming payload
            if (payload && payload.messageId !== opticalSession.lastReceivedId) {
              const res = await processIncomingMessage(payload, identity?.deviceId || '');
              if (res.success) {
                setSyncLog(prev => [`[OPTICAL] Ingested packet from ${sender.substring(0,8)}`, ...prev]);
                setOpticalSession(prev => ({
                  ...prev,
                  lastReceivedId: payload.messageId,
                  pendingAcks: [...prev.pendingAcks, payload.messageId]
                }));
                setScannedMessage(payload);
                loadDbData();
              }
            }

            // 2. Handle incoming ACK
            if (ackId) {
              setOpticalSession(prev => {
                const newOutbox = prev.outbox.filter(m => m.messageId !== ackId);
                if (newOutbox.length < prev.outbox.length) {
                  setSyncLog(prevLog => [`[ACK] Partner confirmed receipt of ${ackId.substring(0,8)}`, ...prevLog]);
                }
                return { ...prev, outbox: newOutbox };
              });
            }
          } 
          // Legacy/One-off chat/sync packets
          else if (data.type === 'chat') {
            const isRecipient = data.payload.toDevice === identity?.deviceId || 
                                data.payload.toDevice === 'OPTICAL_PEER' || 
                                data.payload.toDevice === 'ALL_NODES';
            
            const isKnownContact = contacts.some(c => c.deviceId === data.payload.fromDevice);

            if (isRecipient || isKnownContact) {
              await processIncomingMessage(data.payload, identity?.deviceId || '');
              setScannedMessage(data.payload);
              setSyncLog(prev => [`[OPTICAL] Message received from ${data.payload.fromDevice.substring(0,8)}`, ...prev]);
              loadDbData();
            } else {
              setSyncLog(prev => [`[SECURITY] Unauthorized packet from unknown identity ignored`, ...prev]);
            }
          } else if (data.type === 'sync') {
            let mergedCount = 0;
            for (const msg of data.messages) {
              const isRelevant = msg.toDevice === identity?.deviceId || 
                                msg.toDevice === 'ALL_NODES' || 
                                msg.fromDevice === identity?.deviceId;
              
              if (isRelevant) {
                await processIncomingMessage(msg, identity?.deviceId || '');
                mergedCount++;
              }
            }
            setSyncLog(prev => [`[OPTICAL] Sync complete: ${mergedCount} relevant packets merged`, ...prev]);
            loadDbData();
          }
        } catch (e) {
          // console.error("Failed to parse scanned data:", e);
        }
      }, (error) => {
        // Silent error for scanning frames
      });
    }

    return () => {
      if (scanner) {
        scanner.clear().catch(console.error);
      }
    };
  }, [qrMode, identity, lastScannedData, opticalSession.lastReceivedId]);

  // Optical Frame Generator
  useEffect(() => {
    if (qrMode !== 'live' || !identity) return;

    const generateNextFrame = async () => {
      // 1. Get messages to relay/send
      const pendingMessages = await db.messages.where('status').equals('pending').toArray();
      const currentOutbox = pendingMessages.filter(m => m.fromDevice === identity.deviceId);
      const relayMessages = pendingMessages.filter(m => m.fromDevice !== identity.deviceId);

      // 2. Select priority payload
      const nextPayload = currentOutbox[0] || relayMessages[0] || null;
      
      // 3. Select next pending ACK
      const nextAck = opticalSession.pendingAcks[0] || null;

      const frame = {
        type: 'live_frame',
        sender: identity.deviceId,
        // Using a static session marker instead of granular time to ensure QR stability
        version: 1, 
        ackId: nextAck,
        payload: nextPayload
      };

      // Only updating QR if content actually changed
      const frameString = JSON.stringify(frame);
      setQrChunks(prev => {
        if (prev[0] === frameString) return prev;
        return [frameString];
      });
      
      // If we just "sent" an ACK, we should remove it from pending (simple approach)
      if (nextAck) {
        setOpticalSession(prev => ({
          ...prev,
          pendingAcks: prev.pendingAcks.filter(id => id !== nextAck)
        }));
      }
    };

    const interval = setInterval(generateNextFrame, 5000); // 5s stabilization window
    return () => clearInterval(interval);
  }, [qrMode, identity, opticalSession.pendingAcks]);

  const handleStartQrSend = async () => {
    setQrMode('send');
    let payload;
    
    if (selectedConversation && selectedConversation !== 'ALL_NODES') {
      // Send messages specifically for this conversation
      const convMsgs = await db.messages
        .where('toDevice').equals(selectedConversation)
        .or('fromDevice').equals(selectedConversation)
        .toArray();
      payload = JSON.stringify({ type: 'sync', messages: convMsgs });
    } else {
      const localMsgs = await db.messages.toArray();
      payload = JSON.stringify({ type: 'sync', messages: localMsgs });
    }

    const chunks = chunkPayload(payload);
    setQrChunks(chunks);
    setCurrentChunkIndex(0);
    
    const interval = setInterval(() => {
      setCurrentChunkIndex(prev => (prev + 1) % chunks.length);
    }, 6000); // Very slow rotation for maximum stability during manual scan
    setSyncLog(prev => [`[HANDSHAKE] Optical stream initialized`, ...prev]);
    return () => clearInterval(interval);
  };

  const handleBLESnap = async () => {
    setSyncLog(prev => [`[BLE] Pulse scanning for nearby beacons...`, ...prev]);
    setTimeout(() => {
      setSyncLog(prev => [`[BLE] Discovery: Found NODE_BETA at 3.2m`, ...prev]);
      handleSimulateSync();
    }, 1500);
  };

  const handleSimulateSync = async () => {
    setSyncLog(prev => [`[SYNC] Merging vector gradients...`, ...prev]);
    setTimeout(() => {
      setSyncLog(prev => [`[PROTOCOL] 12 packets merged into local segment`, ...prev]);
      loadDbData();
    }, 2000);
  };

  const handleAddSampleContact = async () => {
    const id = crypto.randomUUID();
    const isFirst = contacts.length === 0;
    await upsertContact({
      deviceId: id,
      publicKey: "PUBLIC_KEY_" + id.substring(0, 8),
      lastSeen: Date.now(),
      trustScore: isFirst ? 98 : 45 + Math.random() * 50,
      reputation: isFirst ? 85 : 10 + Math.random() * 40,
      routingHops: isFirst ? 1 : Math.floor(Math.random() * 3) + 1,
      isVerified: isFirst
    });
    loadDbData();
    setSyncLog(prev => [`[PEER] New identity cataloged: ${id.substring(0, 8)}`, ...prev]);
  };

  const handleAddSampleMessage = async () => {
    const remoteId = contacts[0]?.deviceId || "SYSTEM_RELAY";
    await addMessage({
      messageId: crypto.randomUUID(),
      type: 'chat',
      content: "Protocol handshake received. Mesh state synchronized.",
      fromDevice: remoteId,
      toDevice: identity?.deviceId || "SELF",
      status: 'delivered',
      hopCount: remoteId === "SYSTEM_RELAY" ? 3 : 1,
      expiresAt: Date.now() + 3600000
    });
    loadDbData();
  };

  const handleStartLiveChat = () => {
    setQrMode('live');
    setSyncLog(prev => [`[LINK] Live Optical Session Request initialized`, ...prev]);
  };

  const handleSimulateIncoming = async () => {
    if (!identity) return;
    await processIncomingMessage({
      messageId: crypto.randomUUID(),
      fromDevice: "REMOTE_NODE_" + Math.random().toString(36).substring(7),
      toDevice: identity.deviceId,
      type: 'chat',
      content: "ALERT: Network capacity at 85% in sector 4",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      hopCount: 1,
      status: 'pending'
    }, identity.deviceId);
    loadDbData();
  };

  const handleExport = async () => {
    const data = await exportMessages();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus_mesh_export_${new Date().toISOString()}.json`;
    a.click();
  };
  
  // Community Drops State
  const [drops, setDrops] = useState<any[]>([]);
  const [newDropContent, setNewDropContent] = useState('');
  const [newDropType, setNewDropType] = useState<'alerts' | 'resources' | 'routes'>('alerts');

  // DB Demo State
  const [messages, setMessages] = useState<Message[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [dropFilter, setDropFilter] = useState<'All' | 'Alerts' | 'Resources' | 'Routes'>('All');

  // Live Stats State
  const [stats, setStats] = useState({
    activeHops: 0,
    reach: '0m',
    integrity: 100,
    meshLoad: 2,
    syncProgress: 0,
    syncSpeed: '0 MB/s',
    totalMeshNodes: 1
  });

  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function switchNode() {
      setLoading(true);
      try {
        await switchDatabaseNode(persona);
        const id = await getIdentity(persona);
        setIdentity(id);
        setDbStatus(`NODE_${persona.toUpperCase()} ACTIVE`);
        
        // Initial setup for the new node
        await purgeExpiredData();
        await loadDbData();
        
        // Clear UI states
        setSelectedConversation(null);
        setSyncLog(prev => [`[SYSTEM] Authenticated as ${id.deviceId}`, ...prev]);
        
      } catch (err) {
        console.error("Failed to switch node:", err);
      } finally {
        setLoading(false);
      }
    }
    switchNode();
  }, [persona]);

  useEffect(() => {
    setStats({
      activeHops: messages.reduce((acc, m) => acc + m.hopCount, 0),
      reach: (contacts.length * 120 + 50) + 'm',
      integrity: 98 + Math.random() * 2,
      meshLoad: Math.floor(messages.length / 2) + 1,
      syncProgress: Math.random() * 100,
      syncSpeed: (1.5 + Math.random() * 2).toFixed(1) + ' MB/s',
      totalMeshNodes: contacts.length + 1
    });
  }, [messages, contacts]);

  const loadDbData = async () => {
    const msgList = await db.messages.orderBy('createdAt').reverse().toArray();
    const contactList = await getContacts();
    const dropList = await getActiveDrops();
    setMessages(msgList);
    setContacts(contactList);
    setDrops(dropList);
  };

  const handleSendDM = async () => {
    const target = selectedConversation || dmTarget;
    if (!target || !dmContent) return;
    const result = await sendDirectMessage(target, dmContent);
    if (result.success) {
      setDmContent('');
      setDmTarget('');
      loadDbData();
      setSyncLog(prev => [`[MSG] Outgoing to ${target}`, ...prev]);
    }
  };

  const handleCreateDrop = async () => {
    if (!newDropContent) return;
    await createDrop(newDropContent, newDropType, { lat: 0, lng: 0 });
    setNewDropContent('');
    loadDbData();
    setSyncLog(prev => [`[DROP] Community update broadcasted`, ...prev]);
  };

  const handleLogin = (nodeId: 'alpha' | 'beta' | 'gamma' | 'delta') => {
    setPersona(nodeId);
    setIsLoggedIn(true);
  };

  const handlePersonaSwitch = (p: typeof persona) => {
    setPersona(p);
  };

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'messages':
        return (
          <div className="flex h-full gap-6 pb-20">
            {/* Conversation Sidebar */}
            <div className="w-80 flex flex-col gap-4">
              <div className="glass-dark rounded-[2rem] border border-white/5 p-6 flex flex-col h-full">
                <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mb-6 flex items-center gap-2 px-2">
                  <Terminal size={12} className="text-cyan-400" />
                  Node Directory
                </h4>
                
                <div className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-hide">
                  <button 
                    onClick={() => setSelectedConversation('ALL_NODES')}
                    className={`w-full p-4 rounded-3xl border transition-all flex items-center gap-3 ${
                      selectedConversation === 'ALL_NODES' 
                        ? 'bg-cyan-500/20 border-cyan-500/50 text-white' 
                        : 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 flex items-center justify-center text-cyan-400 border border-cyan-500/30">
                      <Zap size={20} />
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-bold uppercase tracking-tight">Broadcast</p>
                      <p className="text-[9px] font-medium text-slate-500 uppercase">Public Segment</p>
                    </div>
                  </button>

                  <div className="my-6 border-t border-white/5 relative">
                    <span className="absolute -top-2 left-4 px-2 bg-black text-[8px] font-bold text-slate-600 uppercase tracking-widest">Verified Multi-Hop Nodes</span>
                  </div>

                  {contacts.map((contact) => (
                    <button 
                      key={contact.deviceId}
                      onClick={() => setSelectedConversation(contact.deviceId)}
                      className={`w-full p-4 rounded-3xl border transition-all flex items-center gap-3 group ${
                        selectedConversation === contact.deviceId 
                          ? 'bg-purple-500/20 border-purple-500/50 text-white shadow-[0_0_20px_rgba(168,85,247,0.1)]' 
                          : 'bg-white/5 border-white/5 text-slate-400 hover:bg-white/10'
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center border transition-all ${
                        selectedConversation === contact.deviceId 
                          ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' 
                          : 'bg-white/5 text-slate-500 border-white/5'
                      }`}>
                        <Smartphone size={20} />
                      </div>
                      <div className="text-left flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-bold truncate tracking-tight uppercase">NODE_{contact.deviceId.split('-')[0]}</p>
                          {contact.isVerified && <Shield size={10} className="text-cyan-400" />}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan-500" style={{ width: `${contact.trustScore}%` }}></div>
                          </div>
                          <p className="text-[7px] font-bold text-slate-500 uppercase">{contact.trustScore}%</p>
                        </div>
                      </div>
                    </button>
                  ))}

                  {contacts.length === 0 && (
                    <div className="p-8 text-center text-slate-600 italic">
                      <Users size={32} className="mx-auto mb-4 opacity-10" />
                      <p className="text-[10px] font-medium uppercase tracking-[0.2em] leading-relaxed">Scan peers to initialize direct link</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex flex-col gap-4">
              <div className="flex-1 glass-dark rounded-[3rem] border border-white/5 flex flex-col relative overflow-hidden">
                <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/2 backdrop-blur-xl z-20">
                   <div className="flex items-center gap-4">
                     <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20 shadow-inner">
                       {selectedConversation === 'ALL_NODES' ? <Zap size={24} /> : <MessageSquare size={24} />}
                     </div>
                     <div>
                       <h3 className="text-sm font-bold text-white uppercase tracking-widest">
                         {selectedConversation ? (selectedConversation === 'ALL_NODES' ? 'Segment Broadcast' : `NODE_${selectedConversation.split('-')[0]}`) : 'Transmission Interface'}
                       </h3>
                       <div className="flex items-center gap-3">
                          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5 peer">
                            <Shield size={10} className="text-cyan-400" />
                            XSalsa20 Secure Link
                          </p>
                          <div className="h-1 w-1 bg-slate-700 rounded-full"></div>
                          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest group-hover:text-cyan-400">
                             {selectedConversation === 'ALL_NODES' ? '0 Hops' : 'P2P Direct'}
                          </p>
                       </div>
                     </div>
                   </div>
                   <div className="flex items-center gap-3">
                      <div className="px-4 py-2 bg-black/40 rounded-2xl border border-white/5 flex items-center gap-3">
                        <div className="flex -space-x-2">
                           {[...Array(3)].map((_, i) => (
                             <div key={i} className="w-4 h-4 rounded-full bg-slate-800 border border-black text-[6px] flex items-center justify-center font-bold text-slate-500">
                               {String.fromCharCode(65 + i)}
                             </div>
                           ))}
                        </div>
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Mesh Relay path</span>
                      </div>
                   </div>
                </div>

                {/* Messages Feed */}
                <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide">
                  {messages
                    .filter(m => selectedConversation === 'ALL_NODES' ? m.toDevice === 'ALL_NODES' : (m.toDevice === selectedConversation || m.fromDevice === selectedConversation))
                    .map((msg) => (
                    <motion.div 
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      key={msg.id}
                      className={`flex flex-col ${msg.fromDevice === identity?.deviceId ? 'items-end' : 'items-start'}`}
                    >
                      <div className={`max-w-[85%] rounded-[2.5rem] p-6 border relative transition-all hover:scale-[1.01] ${
                        msg.fromDevice === identity?.deviceId 
                          ? 'bg-gradient-to-br from-cyan-500/20 to-blue-500/5 border-cyan-500/30 text-cyan-50 shadow-[0_10px_30px_rgba(6,182,212,0.1)]' 
                          : 'bg-white/5 border-white/10 text-slate-200'
                      }`}>
                         {msg.fromDevice !== identity?.deviceId && (
                            <p className="text-[8px] font-bold text-cyan-400 uppercase tracking-widest mb-2 opacity-60">
                               FROM // NODE_{msg.fromDevice.split('-')[0]}
                            </p>
                         )}
                        <p className="text-sm font-medium leading-relaxed tracking-wide">{msg.content}</p>
                        
                        <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-6">
                           <div className="flex items-center gap-3">
                              <span className="text-[8px] font-mono opacity-40 uppercase">{new Date(msg.createdAt).toLocaleTimeString()}</span>
                              <div className="h-3 w-[1px] bg-white/10"></div>
                              <div className="flex items-center gap-1.5">
                                 <Radio size={10} className="text-cyan-400 opacity-50" />
                                 <span className="text-[8px] font-bold uppercase tracking-widest opacity-40">
                                   {msg.hopCount} Hops
                                 </span>
                              </div>
                           </div>
                           <div className="flex items-center gap-2">
                             {msg.status === 'delivered' && <CheckCircle2 size={12} className="text-emerald-400" />}
                             <span className="text-[8px] font-bold uppercase tracking-widest opacity-40">
                               {msg.status}
                             </span>
                           </div>
                        </div>

                        {/* Relay visualization */}
                        {msg.hopCount > 1 && (
                          <div className="mt-3 flex items-center gap-2 px-2 py-1.5 bg-black/20 rounded-full border border-white/5 self-start">
                             <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full shadow-[0_0_5px_rgba(52,211,153,0.5)]"></div>
                             <span className="text-[7px] font-bold text-slate-500 uppercase tracking-widest">Verified Relay: Multi-Hop Pattern Detected</span>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}

                  {(!selectedConversation || messages.filter(m => selectedConversation === 'ALL_NODES' ? m.toDevice === 'ALL_NODES' : (m.toDevice === selectedConversation || m.fromDevice === selectedConversation)).length === 0) && (
                    <div className="h-full flex flex-col items-center justify-center text-slate-700">
                      <div className="w-32 h-32 rounded-full bg-white/5 border border-white/5 flex items-center justify-center mb-6 relative">
                         <div className="absolute inset-0 bg-cyan-500/5 rounded-full animate-ping"></div>
                         <Radio size={48} className="text-cyan-500/20" />
                      </div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-cyan-500/30">Awaiting Signal Ingress</p>
                    </div>
                  )}
                </div>

                {/* Input Area */}
                <div className="p-8 border-t border-white/5 bg-black/40 backdrop-blur-2xl">
                   <div className="relative group">
                     <textarea 
                       value={dmContent}
                       onChange={(e) => setDmContent(e.target.value)}
                       placeholder={selectedConversation ? "ENTER PACKET CONTENT..." : "SELECT TARGET NODE..."}
                       disabled={!selectedConversation}
                       className="w-full bg-black/60 border border-white/10 rounded-[2.5rem] p-6 pr-24 text-sm text-cyan-50 focus:outline-none focus:border-cyan-500/40 transition-all resize-none h-28 scrollbar-hide font-mono tracking-wide placeholder:text-slate-800"
                       onKeyDown={(e) => {
                         if (e.key === 'Enter' && !e.shiftKey) {
                           e.preventDefault();
                           handleSendDM();
                         }
                       }}
                     />
                     <button 
                       onClick={handleSendDM}
                       disabled={!selectedConversation || !dmContent}
                       className="absolute right-4 bottom-4 w-16 h-16 bg-cyan-500 hover:bg-cyan-400 text-black rounded-[1.5rem] flex items-center justify-center shadow-[0_10px_30px_rgba(6,182,212,0.3)] transition-all active:scale-95 disabled:opacity-20 disabled:grayscale"
                     >
                       <Send size={24} />
                     </button>
                   </div>
                </div>
              </div>

              {/* Protocol Monitor */}
              <div className="h-32 glass rounded-[2rem] border border-white/5 p-4 flex flex-col">
                <div className="flex items-center gap-2 mb-2 px-2">
                  <Activity size={10} className="text-cyan-400 animate-pulse" />
                  <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest">Protocol Monitor</span>
                </div>
                <div className="flex-1 font-mono text-[8px] text-cyan-500/40 space-y-0.5 overflow-hidden select-text">
                  {syncLog.slice(0, 4).map((log, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="opacity-20">{new Date().toLocaleTimeString()}</span>
                      <span>{log}</span>
                    </div>
                  ))}
                  {syncLog.length === 0 && <p className="opacity-20 italic">Listening for mesh handshake packets...</p>}
                </div>
              </div>
            </div>
          </div>
        );
      case 'drops':
        return (
          <div className="flex flex-col h-full gap-6 pb-20">
            {/* Header Controls */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 glass-dark p-6 rounded-[2.5rem] border border-white/5">
              <div className="flex gap-2 p-1 bg-white/5 rounded-2xl border border-white/5">
                {['All', 'Alerts', 'Resources', 'Routes'].map((cat) => (
                  <button 
                    key={cat} 
                    onClick={() => setDropFilter(cat as any)}
                    className={`px-6 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] transition-all flex items-center gap-2 ${
                      dropFilter === cat 
                        ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {cat === 'Alerts' && <Zap size={10} />}
                    {cat}
                  </button>
                ))}
              </div>
              
              <div className="flex gap-4">
                <button 
                  onClick={() => setQrMode('drop')}
                  className="px-6 py-3 bg-cyan-500 hover:bg-cyan-400 text-black rounded-2xl text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-cyan-500/10 transition-all"
                >
                  <QrCode size={14} />
                  Deploy New Drop
                </button>
              </div>
            </div>

            {/* Creation Modal (conditionally shown or as a drawer) */}
            {qrMode === 'drop' && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="glass-dark border border-cyan-500/30 rounded-[3rem] p-8 relative overflow-hidden"
              >
                <div className="absolute top-4 right-4 text-slate-500 hover:text-white cursor-pointer" onClick={() => setQrMode('none')}>
                  <XCircle size={24} />
                </div>
                <h4 className="text-[10px] font-bold text-cyan-400 uppercase tracking-[0.3em] mb-8 flex items-center gap-2">
                  <MapPin size={12} />
                  Packet Distribution Configuration
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
                  <div className="md:col-span-4">
                    <label className="text-[9px] font-bold text-slate-600 uppercase mb-3 block px-2">Segment Classification</label>
                    <div className="grid grid-cols-3 gap-2">
                       {(['alerts', 'resources', 'routes'] as const).map(type => (
                         <button 
                           key={type}
                           onClick={() => setNewDropType(type)}
                           className={`py-4 rounded-2xl text-[10px] font-bold uppercase border transition-all ${
                             newDropType === type 
                               ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-400' 
                               : 'bg-white/5 border-white/5 text-slate-500'
                           }`}
                         >
                           {type}
                         </button>
                       ))}
                    </div>
                  </div>
                  <div className="md:col-span-8">
                    <label className="text-[9px] font-bold text-slate-600 uppercase mb-3 block px-2">Intelligence Payload</label>
                    <div className="relative">
                      <textarea 
                        value={newDropContent}
                        onChange={(e) => setNewDropContent(e.target.value)}
                        placeholder="Detail information for local segment..."
                        className="w-full bg-black/40 border border-white/10 rounded-3xl p-5 text-sm text-white focus:outline-none focus:border-cyan-500/40 min-h-[120px] resize-none"
                      />
                      <button 
                        onClick={handleCreateDrop}
                        className="absolute right-4 bottom-4 px-8 py-3 bg-cyan-500 hover:bg-cyan-400 text-black rounded-2xl text-[10px] font-bold uppercase shadow-xl transition-all"
                      >
                        Generate QR Seal
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Drops Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {drops
                .filter(d => dropFilter === 'All' || d.type === dropFilter.toLowerCase())
                .map((drop) => (
                <motion.div 
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  key={drop.id} 
                  className="glass-dark rounded-[3rem] border border-white/5 p-8 relative group hover:border-cyan-500/20 transition-all flex flex-col justify-between h-64 overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-6">
                    <div className={`px-3 py-1 rounded-full text-[8px] font-bold uppercase tracking-widest ${
                      drop.type === 'alerts' ? 'bg-rose-500/10 text-rose-400' :
                      drop.type === 'resources' ? 'bg-cyan-500/10 text-cyan-400' :
                      'bg-purple-500/10 text-purple-400'
                    }`}>
                      {drop.type}
                    </div>
                  </div>

                  <div className="relative z-10 flex items-start gap-4">
                     <div className={`w-14 h-14 rounded-[1.5rem] flex items-center justify-center border transition-all ${
                       drop.type === 'alerts' ? 'bg-rose-500/10 border-rose-500/20 text-rose-500' :
                       drop.type === 'resources' ? 'bg-cyan-500/10 border-cyan-500/20 text-cyan-500' :
                       'bg-purple-500/10 border-purple-500/20 text-purple-500'
                     }`}>
                       <MapPin size={28} />
                     </div>
                     <div className="flex-1 min-w-0 pt-1">
                        <p className="text-sm font-bold text-white line-clamp-2 leading-tight uppercase mb-1">{drop.content}</p>
                        <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                          <Activity size={10} className="text-cyan-400" />
                          Local Segment Broadcast
                        </p>
                     </div>
                  </div>

                  <div className="relative z-10 pt-6 border-t border-white/5 flex items-end justify-between">
                     <div>
                        <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1.5 leading-none px-1">Expiry Pulse</p>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-mono text-cyan-400 font-bold tracking-tighter">48</span>
                          <span className="text-[10px] font-bold text-cyan-400/50 uppercase tracking-widest">Hours</span>
                        </div>
                     </div>
                     <button className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-slate-400 hover:text-white transition-all">
                        <ExternalLink size={20} />
                     </button>
                  </div>
                </motion.div>
              ))}

              {drops.length === 0 && (
                <div className="col-span-full h-80 glass rounded-[3rem] border border-dashed border-white/10 flex flex-col items-center justify-center text-slate-700">
                  <div className="w-20 h-20 rounded-full border-2 border-white/5 flex items-center justify-center mb-6">
                    <Radio size={40} className="opacity-20 animate-pulse" />
                  </div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.4em] mb-2">Segment Silence</p>
                  <p className="text-xs font-medium max-w-[200px] text-center leading-relaxed">No community intelligence packets detected in local proximity.</p>
                </div>
              )}
            </div>
          </div>
        );
      case 'sync':
        return (
          <div className="flex flex-col gap-8 h-full pb-20 overflow-y-auto scrollbar-hide p-1">
            {/* Sync Mode Selection */}
            <div className="flex items-center gap-4 glass-dark p-6 rounded-[2.5rem] border border-white/5 shadow-lg relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-cyan-500/20 via-purple-500/20 to-amber-500/20"></div>
              {[
                { id: 'send', label: 'One-Way', icon: Share2, color: 'text-cyan-400' },
                { id: 'receive', label: 'Ingest', icon: QrCode, color: 'text-purple-400' },
                { id: 'live', label: 'Optical Tunnel', icon: Zap, color: 'text-amber-400' }
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    if (m.id === 'send') handleStartQrSend();
                    else setQrMode(m.id as any);
                  }}
                  className={`flex-1 flex items-center justify-center gap-3 py-5 rounded-3xl border transition-all ${
                    qrMode === m.id 
                      ? 'bg-white/10 border-white/20 text-white shadow-[0_10px_40px_rgba(0,0,0,0.3)] scale-[1.02]' 
                      : 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  <m.icon size={18} className={qrMode === m.id ? m.color : ''} />
                  <div className="flex flex-col items-start">
                    <span className="text-[10px] font-bold uppercase tracking-widest leading-none">{m.label}</span>
                    <span className="text-[7px] font-bold text-slate-600 uppercase mt-1 tracking-tight">Handshake Mode</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-8 min-h-[600px]">
              {/* Left Column: Transmission / QR Output (THE VOICE) */}
              <div className={`p-10 glass-dark rounded-[3.5rem] border border-white/5 flex flex-col items-center justify-center shadow-3xl relative overflow-hidden transition-all duration-500 ${qrMode === 'live' ? 'lg:order-2 border-amber-500/20' : ''}`}>
                 <div className="absolute top-0 left-0 w-full p-10 text-center bg-gradient-to-b from-black/40 to-transparent border-b border-white/5">
                    <div className="flex items-center justify-center gap-2 mb-2">
                       <Radio size={12} className="text-cyan-400 animate-pulse" />
                       <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-[0.4em]">Optical Voice Transmitter</p>
                    </div>
                    <p className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">Target: {selectedConversation || 'ALL_NODES'}</p>
                 </div>

                 <div className="bg-white p-8 rounded-[3.5rem] shadow-[0_0_100px_rgba(255,255,255,0.06)] relative scale-110 lg:scale-125 hover:scale-[1.3] transition-transform duration-700">
                   <QRCodeSVG 
                     value={qrChunks[currentChunkIndex] || JSON.stringify({
                       type: 'beacon',
                       nodeId: identity?.deviceId,
                       timestamp: Date.now()
                     })} 
                     size={220} 
                     level="M"
                     includeMargin={false}
                   />
                   <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.05]">
                      <Zap size={140} className="text-black" />
                   </div>
                 </div>

                 {/* ACK Overlay for Transmitter */}
                 {opticalSession.lastReceivedId && qrMode === 'live' && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="absolute top-[65%] px-4 py-1.5 bg-emerald-500 text-black text-[9px] font-black uppercase rounded-full tracking-[0.2em] shadow-lg flex items-center gap-2"
                    >
                       <CheckCircle2 size={10} />
                       ACK Verified
                    </motion.div>
                 )}

                 <div className="absolute bottom-10 flex flex-col items-center gap-6 w-full">
                    <div className="flex gap-2.5">
                       {(qrChunks.length > 1 ? qrChunks : [1,2,3]).map((_, i) => (
                         <div key={i} className={`h-1 rounded-full transition-all duration-500 ${i === currentChunkIndex ? 'w-8 bg-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.6)]' : 'w-2 bg-white/10'}`}></div>
                       ))}
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] font-bold text-white uppercase tracking-[0.3em]">
                         {qrChunks.length > 1 ? `Syncing Frame ${currentChunkIndex + 1} // ${qrChunks.length}` : 'Beacon Loop Active'}
                      </span>
                      <span className="text-[8px] font-bold text-slate-600 uppercase tracking-widest">Rate: 1.5s Optical Step</span>
                    </div>
                 </div>
              </div>

              {/* Right Column: Reception / Scanner (THE EYE) */}
              <div className={`glass-dark rounded-[3.5rem] border border-white/10 relative overflow-hidden flex flex-col shadow-3xl ${qrMode === 'live' ? 'lg:order-1 border-purple-500/30' : ''}`}>
                <div className="absolute top-0 left-0 w-full p-8 z-20 flex justify-between items-center pointer-events-none">
                   <div className="px-5 py-2.5 bg-black/80 backdrop-blur-3xl rounded-3xl border border-white/10 flex items-center gap-3 shadow-2xl">
                     <Camera size={16} className="text-purple-400 animate-pulse" />
                     <div className="flex flex-col">
                        <span className="text-[10px] font-black text-white uppercase tracking-widest leading-none">NEXUS EYE</span>
                        <span className="text-[7px] font-bold text-purple-400/60 uppercase mt-0.5 tracking-tighter">Optical Segment Sensor</span>
                     </div>
                   </div>
                </div>

                {/* Scanner Interface */}
                { (qrMode === 'receive' || qrMode === 'live') ? (
                  <div className="flex-1 flex flex-col">
                    <div className="flex-1 relative">
                       <div id="reader" className="w-full h-full grayscale opacity-70"></div>
                       <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-12">
                          <div className="w-full h-full max-w-sm max-h-sm border-2 border-white/10 rounded-[4rem] relative overflow-hidden">
                             <div className="absolute inset-0 border-white/5 border-[48px]"></div>
                             
                             <motion.div 
                               animate={{ top: ['0%', '100%', '0%'] }}
                               transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                               className="absolute left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-purple-500 to-transparent shadow-[0_0_30px_rgba(168,85,247,1)]"
                             />

                             {/* Corner Accents */}
                             <div className="absolute top-8 left-8 w-8 h-8 border-t-2 border-l-2 border-purple-500/40 rounded-tl-2xl"></div>
                             <div className="absolute top-8 right-8 w-8 h-8 border-t-2 border-r-2 border-purple-500/40 rounded-tr-2xl"></div>
                             <div className="absolute bottom-8 left-8 w-8 h-8 border-b-2 border-l-2 border-purple-500/40 rounded-bl-2xl"></div>
                             <div className="absolute bottom-8 right-8 w-8 h-8 border-b-2 border-r-2 border-purple-500/40 rounded-br-2xl"></div>
                          </div>
                       </div>
                       
                       <div className="absolute bottom-8 left-0 w-full flex justify-center">
                          <div className="px-6 py-2 bg-black/60 rounded-full border border-white/5 text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em] backdrop-blur-md">
                             Sensor Resolution: 1280px Pulse
                          </div>
                       </div>
                    </div>
                    
                    {/* Reception Log Viewer */}
                    <div className="h-64 p-10 bg-gradient-to-t from-black/90 to-black/60 backdrop-blur-3xl border-t border-white/10 overflow-y-auto scrollbar-hide">
                       <div className="flex items-center justify-between mb-6">
                         <div className="flex items-center gap-2">
                            <Database size={12} className="text-purple-400" />
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Segment Ingestion</p>
                         </div>
                         <button onClick={() => setSyncLog([])} className="text-[8px] font-black text-slate-700 hover:text-white uppercase tracking-widest transition-all p-2 bg-white/5 rounded-lg border border-white/5">Flush Segment</button>
                       </div>
                       <div className="space-y-3">
                          {syncLog.map((log, i) => (
                            <motion.div 
                              initial={{ opacity: 0, x: -15 }}
                              animate={{ opacity: 1, x: 0 }}
                              key={i} 
                              className="text-[10px] font-mono flex items-start gap-5 p-4 bg-white/2 rounded-3xl border border-white/5 group hover:border-purple-500/20 transition-all"
                            >
                               <span className="text-purple-500 font-bold shrink-0 opacity-40">{new Date().toLocaleTimeString().split(' ')[0]}</span>
                               <span className="text-slate-300 leading-relaxed font-medium">{log}</span>
                               <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                                  <CheckCircle2 size={12} className="text-emerald-500" />
                               </div>
                            </motion.div>
                          ))}
                          {syncLog.length === 0 && (
                            <div className="h-full flex flex-col items-center justify-center opacity-30 py-12">
                               <div className="w-16 h-16 rounded-full border border-white/5 flex items-center justify-center mb-6">
                                  <Radio size={24} className="animate-pulse text-white/50" />
                               </div>
                               <p className="text-[10px] font-black uppercase tracking-[0.4em] text-white/40">Searching for Optical Partner</p>
                            </div>
                          )}
                       </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center p-20 text-center bg-black/10">
                    <div className="w-32 h-32 rounded-[2.5rem] bg-white/5 border border-white/10 flex items-center justify-center mb-10 shadow-2xl relative">
                       <div className="absolute inset-0 bg-purple-500/5 rounded-[2.5rem] animate-pulse"></div>
                       <Camera size={48} className="text-slate-700 relative z-10" />
                    </div>
                    <h3 className="text-sm font-black text-white uppercase tracking-[0.4em] mb-6">Sensor Offline</h3>
                    <p className="text-[10px] text-slate-500 leading-relaxed max-w-[280px] uppercase font-bold tracking-widest px-4">
                      Initialize the focal sensor array for ingestion or live optical tunnel link.
                    </p>
                    <button 
                      onClick={() => setQrMode('receive')}
                      className="mt-14 px-12 py-5 bg-purple-500 hover:bg-purple-400 text-black rounded-[1.8rem] text-[10px] font-black uppercase tracking-widest transition-all shadow-[0_15px_40px_rgba(168,85,247,0.3)] active:scale-95"
                    >
                      Activate Reception Sensor
                    </button>
                    <p className="mt-8 text-[8px] font-bold text-slate-800 uppercase tracking-widest">Security: Metadata stripped on ingestion</p>
                  </div>
                )}
              </div>
            </div>

            {/* Live Chat Overlay (Dialog style) */}
            {qrMode === 'live' && (
              <motion.div 
                initial={{ opacity: 0, y: 100 }}
                animate={{ opacity: 1, y: 0 }}
                className="fixed bottom-32 left-1/2 -translate-x-1/2 w-[90%] max-w-xl glass-dark rounded-[3rem] border border-amber-500/40 p-8 shadow-[0_30px_100px_rgba(245,158,11,0.2)] z-[60]"
              >
                 <div className="flex items-center justify-between mb-6 px-2">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-500 border border-amber-500/20 shadow-[0_0_15px_rgba(245,158,11,0.2)]">
                          <Zap size={20} />
                       </div>
                       <div>
                         <h4 className="text-xs font-bold text-white uppercase tracking-[0.2em]">Live Optical Tunnel</h4>
                         <p className="text-[9px] font-bold text-amber-500/50 uppercase tracking-widest">Full-Duplex Link Active</p>
                       </div>
                    </div>
                    <button 
                      onClick={() => setQrMode('none')}
                      className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-slate-500 hover:text-white transition-all shadow-inner"
                    >
                      <X size={18} />
                    </button>
                 </div>
                 
                 <div className="relative group">
                    <input 
                      type="text"
                      value={dmContent}
                      onChange={(e) => setDmContent(e.target.value)}
                      placeholder="ENTER OPTICAL PAYLOAD..."
                      className="w-full bg-black border border-white/10 rounded-[2rem] p-5 pr-20 text-xs text-amber-400 focus:outline-none focus:border-amber-500/50 transition-all font-mono tracking-widest placeholder:text-slate-800"
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && dmContent) {
                          const msgData = {
                              messageId: crypto.randomUUID(),
                              fromDevice: identity?.deviceId || '',
                              content: dmContent,
                              expiresAt: Date.now() + (48 * 60 * 60 * 1000),
                              hopCount: 1,
                              type: 'chat',
                              toDevice: 'OPTICAL_PEER',
                              status: 'delivered' as const
                          };
                          
                          await addMessage(msgData);
                          
                          const payload = JSON.stringify({
                            type: 'chat',
                            payload: { ...msgData, createdAt: Date.now() }
                          });
                          setQrChunks([payload]);
                          setDmContent('');
                          setSyncLog(prev => [`[TX] Message staged in light tunnel`, ...prev]);
                          loadDbData();
                        }
                      }}
                    />
                    <button 
                      disabled={!dmContent}
                      onClick={async () => {
                        const msgData = {
                            messageId: crypto.randomUUID(),
                            fromDevice: identity?.deviceId || '',
                            content: dmContent,
                            expiresAt: Date.now() + (48 * 60 * 60 * 1000),
                            hopCount: 1,
                            type: 'chat',
                            toDevice: 'OPTICAL_PEER',
                            status: 'delivered' as const
                        };
                        
                        await addMessage(msgData);
                        
                        const payload = JSON.stringify({
                          type: 'chat',
                          payload: { ...msgData, createdAt: Date.now() }
                        });
                        setQrChunks([payload]);
                        setDmContent('');
                        setSyncLog(prev => [`[TX] Message staged in light tunnel`, ...prev]);
                        loadDbData();
                      }}
                      className="absolute right-3 top-3 w-12 h-12 bg-amber-500 text-black rounded-2xl flex items-center justify-center shadow-lg shadow-amber-500/20 active:scale-95 transition-all disabled:opacity-20"
                    >
                      <Send size={18} />
                    </button>
                 </div>
                 <div className="mt-6 flex items-center justify-center gap-8">
                    <div className="flex items-center gap-2 opacity-50">
                       <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                       <span className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em]">Handshake Solid</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-50">
                       <Radio size={10} className="text-amber-500" />
                       <span className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em]">Zero Emission Mode</span>
                    </div>
                 </div>
              </motion.div>
            )}
          </div>
        );
      case 'contacts':
        return (
          <div className="flex flex-col h-full gap-6 pb-20">
            {/* Global Directory Header */}
            <div className="p-10 glass-dark rounded-[3.5rem] border border-white/5 shadow-2xl relative overflow-hidden group">
               <div className="absolute inset-0 bg-gradient-to-r from-purple-500/5 to-cyan-500/5 opacity-50"></div>
               <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity duration-1000">
                 <Shield size={160} />
               </div>
               
               <div className="relative z-10 grid grid-cols-2 lg:grid-cols-4 gap-12">
                  {[
                    { label: 'Validated Nodes', value: contacts.length, icon: Smartphone, color: 'text-cyan-400' },
                    { label: 'Network Integrity', value: '99.9%', icon: Shield, color: 'text-purple-400' },
                    { label: 'Trusted Links', value: contacts.filter(c => c.trustScore > 90).length, icon: CheckCircle2, color: 'text-emerald-400' },
                    { label: 'Active Reach', value: stats.reach, icon: Radio, color: 'text-amber-400' }
                  ].map((item, i) => (
                    <div key={i} className="space-y-1">
                       <div className="flex items-center gap-2 mb-3">
                         <div className={`w-6 h-6 rounded-lg bg-white/5 flex items-center justify-center ${item.color}`}>
                           <item.icon size={12} />
                         </div>
                         <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">{item.label}</span>
                       </div>
                       <p className="text-3xl font-display font-bold text-white tracking-tighter">{item.value}</p>
                    </div>
                  ))}
               </div>
            </div>

            <div className="flex items-center justify-between px-4">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.4em] flex items-center gap-3">
                <Users size={14} className="text-cyan-500" />
                Validated Peer Registry
              </h3>
              <div className="flex gap-3">
                <button 
                  onClick={handleAddSampleContact} 
                  className="px-6 py-2.5 glass rounded-2xl text-[9px] font-bold uppercase tracking-widest text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/10 transition-all flex items-center gap-2"
                >
                  <Smartphone size={12} />
                  Provision Node
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 flex-1">
              {contacts.map((contact) => (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  key={contact.deviceId} 
                  className="glass-dark rounded-[3rem] border border-white/5 hover:border-cyan-500/30 transition-all flex flex-col group overflow-hidden"
                >
                  <div className="p-8 flex-1">
                    <div className="flex items-start justify-between mb-8">
                       <div className="w-16 h-16 rounded-[2rem] bg-gradient-to-br from-cyan-500/20 to-purple-500/20 flex items-center justify-center text-white border border-white/10 group-hover:scale-105 transition-transform duration-500">
                         <div className="w-10 h-10 rounded-[1.2rem] bg-black/40 flex items-center justify-center">
                           <Laptop size={24} className="text-cyan-400" />
                         </div>
                       </div>
                       <div className={`px-3 py-1 rounded-full text-[9px] font-bold flex items-center gap-2 ${
                         contact.trustScore > 90 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                       }`}>
                         <Zap size={10} fill="currentColor" />
                         {contact.trustScore}% INTEGRITY
                       </div>
                    </div>

                    <div className="space-y-6">
                       <div>
                          <h4 className="text-sm font-bold text-white tracking-tight uppercase mb-1">NODE_{contact.deviceId.split('-')[0]}</h4>
                          <p className="text-[10px] font-mono text-slate-500 truncate">{contact.deviceId}</p>
                       </div>

                       <div className="space-y-4">
                          <div className="space-y-2">
                             <div className="flex items-center justify-between px-1">
                                <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Trust Pulse</span>
                                <span className="text-[9px] font-mono text-cyan-400 font-bold">{contact.trustScore}%</span>
                             </div>
                             <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden p-[1px]">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${contact.trustScore}%` }}
                                  className="h-full bg-cyan-500 rounded-full shadow-[0_0_10px_rgba(6,182,212,0.8)]"
                                />
                             </div>
                          </div>

                          <div className="space-y-2">
                             <div className="flex items-center justify-between px-1">
                                <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Reputation</span>
                                <span className="text-[9px] font-mono text-purple-400 font-bold">Lvl {Math.floor(contact.reputation / 10)}</span>
                             </div>
                             <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden p-[1px]">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${Math.min(100, contact.reputation)}%` }}
                                  className="h-full bg-purple-500 rounded-full shadow-[0_0_10px_rgba(168,85,247,0.8)]"
                                />
                             </div>
                          </div>
                          
                          <div className="flex items-center justify-between px-1">
                            <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Routing Hops</span>
                            <span className="text-[9px] font-mono text-amber-500 font-bold">{contact.routingHops || 'Direct'}</span>
                          </div>
                       </div>
                    </div>
                  </div>

                  <div className="p-4 grid grid-cols-2 gap-2 border-t border-white/5 bg-white/2">
                    <button 
                      onClick={() => { setSelectedConversation(contact.deviceId); setActiveTab('messages'); }}
                      className="py-3 bg-white/5 rounded-2xl text-[9px] font-bold uppercase tracking-widest text-slate-400 hover:bg-cyan-500 hover:text-black transition-all"
                    >
                      Initialize Link
                    </button>
                    <button className="py-3 bg-white/5 rounded-2xl text-[9px] font-bold uppercase tracking-widest text-slate-400 hover:bg-white/10 hover:text-white transition-all">
                      Sync Vector
                    </button>
                  </div>
                </motion.div>
              ))}

              {contacts.length === 0 && (
                <div className="col-span-full h-80 glass rounded-[3rem] border border-dashed border-white/10 flex flex-col items-center justify-center text-slate-700">
                   <div className="w-20 h-20 rounded-full border-2 border-white/5 flex items-center justify-center mb-6">
                     <Users size={40} className="opacity-20 translate-x-1" />
                   </div>
                   <p className="text-[10px] font-bold uppercase tracking-[0.4em] mb-2">Registry Empty</p>
                   <p className="text-xs font-medium max-w-[240px] text-center leading-relaxed">Execute a Bluetooth or Optical handshake to catalog nearby identities.</p>
                </div>
              )}
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  if (!isLoggedIn) {
    return <Login onLogin={handleLogin} />;
  }

  if (loading) {
    return (
      <div className="w-full h-screen bg-slate-50 flex flex-col items-center justify-center text-slate-400">
        <RefreshCw className="w-6 h-6 animate-spin mb-3 text-indigo-600" />
        <p className="text-[10px] font-bold uppercase tracking-widest">Bootstrapping Secure Environment</p>
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-black text-slate-200 flex font-sans overflow-hidden select-none selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Background Effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full"></div>
      </div>

      {/* Side Navigation */}
      <aside className="w-20 lg:w-64 glass-dark shrink-0 z-50 flex flex-col border-r border-white/5">
        <div className="p-6 mb-4 flex items-center justify-center lg:justify-start gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-cyan-400 to-purple-600 rounded-xl flex items-center justify-center text-black shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <Zap size={22} />
          </div>
          <span className="hidden lg:block font-display font-bold text-xl tracking-tighter neon-text-cyan">NEXUS</span>
        </div>

        {/* Persona Switcher (Node Simulation) */}
        <div className="px-4 mb-8">
          <p className="hidden lg:block text-[9px] font-bold text-slate-600 uppercase tracking-[0.2em] mb-3 px-2">Active Persona</p>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-1 bg-white/5 p-1 rounded-2xl border border-white/10">
            {(['alpha', 'beta', 'gamma', 'delta'] as const).map((p) => (
              <button
                key={p}
                onClick={() => handlePersonaSwitch(p)}
                className={`flex items-center justify-center py-2 rounded-xl text-[10px] font-bold uppercase transition-all ${
                  persona === p 
                    ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' 
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                }`}
                title={`Switch to Node ${p.toUpperCase()}`}
              >
                {p[0]}
              </button>
            ))}
          </div>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          {[
            { id: 'messages', icon: MessageSquare, label: 'Messages' },
            { id: 'drops', icon: MapPin, label: 'Geo Drops' },
            { id: 'sync', icon: Radio, label: 'Sync Hub' },
            { id: 'contacts', icon: Users, label: 'Safe Peers' }
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as any)}
              className={`w-full flex items-center justify-center lg:justify-start gap-4 p-3.5 rounded-2xl transition-all duration-300 group relative ${
                activeTab === item.id 
                  ? 'bg-white/10 text-cyan-400 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]' 
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
              }`}
            >
              <item.icon size={22} className={`transition-transform duration-300 ${activeTab === item.id ? 'scale-110' : 'group-hover:scale-110'}`} />
              <span className="hidden lg:block text-sm font-medium tracking-tight">{item.label}</span>
              {activeTab === item.id && (
                <motion.div 
                  layoutId="nav-active"
                  className="absolute left-[-1rem] lg:left-0 w-1 lg:w-1.5 h-6 bg-cyan-500 rounded-r-full shadow-[0_0_15px_rgba(6,182,212,0.8)]"
                />
              )}
            </button>
          ))}
        </nav>

        <div className="p-4 mt-auto">
          <div className="p-4 glass rounded-[2rem] border border-white/5 text-center lg:text-left relative overflow-hidden group">
            <div className="absolute inset-0 bg-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="hidden lg:block mb-2 relative z-10">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Active Node ID</p>
              <p className="text-[11px] font-mono text-cyan-400 font-bold truncate">{identity?.deviceId}</p>
            </div>
            <div className="flex items-center justify-center lg:justify-start gap-2 relative z-10">
              <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.8)]"></div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{persona.toUpperCase()}-SECTOR</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Container */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-black/40">
        {/* Top Header Section */}
        <header className="h-20 glass border-b border-white/5 flex items-center justify-between px-8 z-40">
          <div>
            <h2 className="text-xl font-display font-bold text-white tracking-tight flex items-center gap-2 uppercase">
              {activeTab === 'messages' && 'Secure Relay'}
              {activeTab === 'drops' && 'Mesh Drops'}
              {activeTab === 'sync' && 'Synchronization'}
              {activeTab === 'contacts' && 'Verified Peers'}
            </h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 group cursor-pointer" onClick={() => setActiveTab('contacts')}>
              <div className="text-right hidden sm:block">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Latency</p>
                <p className="text-xs font-mono text-emerald-400">14ms</p>
              </div>
              <div className="w-10 h-10 rounded-full border-2 border-emerald-500/30 p-0.5 group-hover:border-emerald-400 transition-colors">
                <div className="w-full h-full rounded-full bg-slate-800 flex items-center justify-center text-indigo-400">
                  <Shield size={18} />
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 scrollbar-hide relative z-30">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="h-full"
            >
              {renderActiveTab()}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* Scanned Packet Modal */}
      <AnimatePresence>
        {scannedMessage && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="w-full max-w-lg glass-dark border border-cyan-500/30 rounded-[3rem] p-10 shadow-[0_0_100px_rgba(6,182,212,0.2)]"
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 border border-cyan-500/20">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-[0.3em]">Packet Ingested</h3>
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">Source: NODE_{scannedMessage.fromDevice.substring(0, 8)}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setScannedMessage(null)}
                  className="p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-slate-500 transition-all"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="bg-white/5 rounded-[2rem] p-8 border border-white/5 mb-8">
                <p className="text-lg font-medium text-slate-100 leading-relaxed tracking-wide italic">
                  "{scannedMessage.content}"
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></div>
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">Integrity Verified // Metadata Attached</span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => {
                      setSelectedConversation(scannedMessage.fromDevice);
                      setActiveTab('messages');
                      setScannedMessage(null);
                      // Focus input for quick reply
                      setTimeout(() => {
                        const input = document.querySelector('textarea');
                        if (input) input.focus();
                      }, 100);
                    }}
                    className="py-5 bg-cyan-500 hover:bg-cyan-400 text-black rounded-[1.5rem] text-[10px] font-black uppercase tracking-widest transition-all shadow-[0_10px_30px_rgba(6,182,212,0.3)] flex items-center justify-center gap-2"
                  >
                    <Send size={16} />
                    Send Reply
                  </button>
                  <button 
                    onClick={() => {
                      setScannedMessage(null);
                      setQrMode('live');
                    }}
                    className="py-5 bg-white/5 hover:bg-white/10 text-white border border-white/5 rounded-[1.5rem] text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                  >
                    <Zap size={16} />
                    Live Tunnel
                  </button>
                </div>
                <button 
                  onClick={() => setScannedMessage(null)}
                  className="py-4 bg-white/2 hover:bg-white/5 text-slate-500 rounded-[1.2rem] text-[9px] font-bold uppercase tracking-widest transition-all border border-white/5"
                >
                  Dismiss Packet
                </button>
              </div>

              <div className="mt-8 pt-8 border-t border-white/5 flex items-center justify-between opacity-40">
                <div className="flex items-center gap-2">
                  <Lock size={12} className="text-cyan-400" />
                  <span className="text-[9px] font-bold uppercase tracking-widest">XSalsa20 Verified</span>
                </div>
                <span className="text-[9px] font-mono uppercase tracking-[0.2em]">TTL: 48H ACTIVE</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Feedback */}
      <AnimatePresence>
        {relayFeedback && (
          <motion.div 
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className={`fixed bottom-8 right-8 z-[100] px-6 py-4 glass-dark rounded-2xl flex items-center gap-4 border ${
              relayFeedback.success ? 'border-emerald-500/50 neon-border-emerald' : 'border-rose-500/50'
            }`}
          >
            <div className={`p-2 rounded-xl ${relayFeedback.success ? 'bg-emerald-500 text-black' : 'bg-rose-500 text-white'}`}>
              {relayFeedback.success ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Protocol Header</p>
              <p className="text-sm font-bold text-white">{relayFeedback.reason}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
