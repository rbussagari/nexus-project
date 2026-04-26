import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Shield, Lock, Smartphone, Zap, Radio, Terminal } from 'lucide-react';

interface LoginProps {
  onLogin: (nodeId: 'alpha' | 'beta' | 'gamma' | 'delta') => void;
}

export const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [accessCode, setAccessCode] = useState('');
  const [selectedNode, setSelectedNode] = useState<'alpha' | 'beta' | 'gamma' | 'delta' | null>(null);
  const [status, setStatus] = useState<'idle' | 'authorizing' | 'ready'>('idle');

  const handleAccess = () => {
    if (!selectedNode) return;
    setStatus('authorizing');
    setTimeout(() => {
      setStatus('ready');
      setTimeout(() => onLogin(selectedNode), 800);
    }, 1500);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center p-6 overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(6,182,212,0.1),transparent_70%)]"></div>
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-20"></div>

      <motion.div 
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md relative z-10"
      >
        <div className="text-center mb-12">
          <motion.div 
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 4, repeat: Infinity }}
            className="w-20 h-20 bg-gradient-to-br from-cyan-400 to-purple-600 rounded-3xl mx-auto flex items-center justify-center text-black shadow-[0_0_50px_rgba(6,182,212,0.4)] mb-6"
          >
            <Zap size={40} />
          </motion.div>
          <h1 className="text-4xl font-display font-bold text-white tracking-tighter neon-text-cyan mb-2">NEXUS</h1>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.4em]">Decentralized Mesh Network v4.2</p>
        </div>

        <div className="glass-dark border border-white/10 rounded-[3rem] p-8 shadow-2xl relative overflow-hidden">
          {status === 'idle' ? (
            <div className="space-y-8">
              <div>
                <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-4 px-2">Initialize Local Node</p>
                <div className="grid grid-cols-2 gap-3">
                  {(['alpha', 'beta', 'gamma', 'delta'] as const).map((node) => (
                    <button
                      key={node}
                      onClick={() => setSelectedNode(node)}
                      className={`p-4 rounded-2xl border transition-all flex flex-col items-center gap-2 group ${
                        selectedNode === node 
                          ? 'bg-cyan-500/20 border-cyan-500 text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.2)]' 
                          : 'bg-white/5 border-white/5 text-slate-500 hover:border-white/20 hover:text-slate-300'
                      }`}
                    >
                      <Smartphone size={18} className={selectedNode === node ? 'animate-pulse' : 'group-hover:scale-110 transition-transform'} />
                      <span className="text-[10px] font-bold uppercase tracking-widest">Node {node.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-3 px-2">Encryption Key (Simulation)</p>
                <div className="relative">
                  <input 
                    type="password" 
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="ENTER PERSISTENT SEED..."
                    className="w-full bg-black/40 border border-white/10 rounded-2xl p-4 text-xs font-mono text-cyan-400 focus:outline-none focus:border-cyan-500/50 transition-all text-center tracking-[0.5em]"
                  />
                  <Lock size={14} className="absolute right-4 top-4 text-slate-700" />
                </div>
              </div>

              <button 
                onClick={handleAccess}
                disabled={!selectedNode || !accessCode}
                className="w-full py-5 bg-white text-black rounded-2xl font-bold text-[11px] uppercase tracking-[0.3em] shadow-xl shadow-white/10 hover:bg-cyan-400 transition-all active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              >
                Engage Identity
              </button>
            </div>
          ) : (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-24 h-24 relative mb-8">
                <motion.div 
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                  className="absolute inset-0 border-t-2 border-cyan-500 rounded-full"
                />
                <motion.div 
                  animate={{ rotate: -360 }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  className="absolute inset-4 border-b-2 border-purple-500 rounded-full opacity-50"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Shield size={24} className="text-cyan-400 animate-pulse" />
                </div>
              </div>
              <h3 className="text-sm font-bold text-white uppercase tracking-[0.3em] mb-2">
                {status === 'authorizing' ? 'Unlocking Mesh Buffer' : 'Link Established'}
              </h3>
              <p className="text-[9px] font-mono text-cyan-500 opacity-50">
                {status === 'authorizing' ? 'Initializing secure enclave zero-trace handshake...' : 'Segment authorization complete. Redirecting...'}
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-center gap-6">
           <div className="flex items-center gap-2 opacity-30">
              <Radio size={12} className="text-cyan-400" />
              <span className="text-[8px] font-bold text-white uppercase tracking-widest">P2P Mesh</span>
           </div>
           <div className="flex items-center gap-2 opacity-30">
              <Lock size={12} className="text-purple-400" />
              <span className="text-[8px] font-bold text-white uppercase tracking-widest">E2EE Locked</span>
           </div>
           <div className="flex items-center gap-2 opacity-30">
              <Terminal size={12} className="text-amber-400" />
              <span className="text-[8px] font-bold text-white uppercase tracking-widest">Zero-Cloud</span>
           </div>
        </div>
      </motion.div>
    </div>
  );
};
