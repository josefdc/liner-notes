import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ArrowLeft, Play, Pause, Music, ExternalLink, Heart, Disc, Search, ChevronDown, Lock, Unlock } from 'lucide-react';
import { CURRENT_TRACK } from '../constants';
import SmartTimeline from './SmartTimeline';
import GenealogyGraph from './GenealogyGraph';
import InteractiveFactoid from './InteractiveFactoid';
import EstimatedWarning from './EstimatedWarning';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { TrackData, FactoidEntity, Factoid, GenealogyNode } from '../types';

interface PlayerProps {
  trackData: TrackData | null;
  onBack: () => void;
  /** Stream factoids one-by-one via SSE for faster perceived speed */
  onDecryptMoreStream?: (
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void
  ) => Promise<void>;
  // Callback for navigating to a new track from genealogy graph
  onAnalyzeTrack?: (trackId: string, title: string, artist: string) => void;
  // P0:3 — New search callback
  onNewSearch?: () => void;
  // UX: Focus management on phase transition
  headingRef?: React.Ref<HTMLHeadingElement>;
}

// ─── P2:24 Default visible factoids count ───────────────────────────────────
const INITIAL_VISIBLE_FACTOIDS = 3;

const Player: React.FC<PlayerProps> = ({ trackData, onBack, onDecryptMoreStream, onAnalyzeTrack, onNewSearch, headingRef }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'context' | 'player' | 'genealogy'>('player');
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [additionalFactoids, setAdditionalFactoids] = useState<Factoid[]>([]);
  // P3:25 — Decrypt complete toast
  const [showDecryptToast, setShowDecryptToast] = useState(false);
  const [decryptToastCount, setDecryptToastCount] = useState(0);
  // P2:24 — Factoid collapsing
  const [showAllFactoids, setShowAllFactoids] = useState(false);

  // P0:7 — Audio preview ref
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Use provided trackData or fallback to mock data
  const track = trackData || CURRENT_TRACK;
  const allFactoids = useMemo(
    () => [...track.factoids, ...additionalFactoids],
    [track.factoids, additionalFactoids]
  );

  // P2:24 — Visible factoids
  const visibleFactoids = showAllFactoids ? allFactoids : allFactoids.slice(0, INITIAL_VISIBLE_FACTOIDS);
  const hiddenCount = allFactoids.length - INITIAL_VISIBLE_FACTOIDS;

  // Refs for transient values in handleDecryptMore
  const isDecryptingRef = useRef(false);
  const additionalFactoidsRef = useRef<Factoid[]>([]);

  useEffect(() => {
    additionalFactoidsRef.current = additionalFactoids;
  }, [additionalFactoids]);

  // UX: Escape key shortcut to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // P0:7 — Initialize and cleanup audio element
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.5;

    const audio = audioRef.current;
    audio.onplay = () => setIsPlaying(true);
    audio.onpause = () => setIsPlaying(false);
    audio.onended = () => setIsPlaying(false);
    audio.onerror = () => setIsPlaying(false);

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // P0:7 — Toggle audio playback
  const handlePlayPause = useCallback(() => {
    if (!audioRef.current || !track.previewUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      if (audioRef.current.src !== track.previewUrl) {
        audioRef.current.src = track.previewUrl;
      }
      audioRef.current.play().catch(err => {
        console.log('Audio preview blocked:', err);
        setIsPlaying(false);
      });
    }
  }, [isPlaying, track.previewUrl]);

  // Handle entity click - open external search
  const handleEntityClick = useCallback((entity: FactoidEntity) => {
    const query = entity.searchQuery || entity.text;
    window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
  }, []);

  // Handle decrypt more factoids - streams one-by-one for faster perceived speed
  const handleDecryptMore = useCallback(async () => {
    if (!onDecryptMoreStream || isDecryptingRef.current) return;

    isDecryptingRef.current = true;
    setIsDecrypting(true);
    let newCount = 0;
    try {
      const existingIds = [...track.factoids, ...additionalFactoidsRef.current].map(f => f.id);

      // Stream factoids - each one is added immediately when received
      await onDecryptMoreStream(
        track.title,
        track.artist,
        existingIds,
        (newFactoid) => {
          setAdditionalFactoids(prev => [...prev, newFactoid]);
          newCount++;
        }
      );

      // P3:25 — Show completion toast
      if (newCount > 0) {
        setDecryptToastCount(newCount);
        setShowDecryptToast(true);
        setTimeout(() => setShowDecryptToast(false), 1000);
      }
    } catch (error) {
      console.error('Decrypt stream error:', error);
    } finally {
      isDecryptingRef.current = false;
      setIsDecrypting(false);
    }
  }, [onDecryptMoreStream, track.title, track.artist, track.factoids]);

  // Extract onNodeClick handler for GenealogyGraph (stable ref for React.memo)
  const handleNodeClick = useCallback((node: GenealogyNode) => {
    if (!onAnalyzeTrack) return;
    const title = node.trackTitle || node.label.split(' - ')[0] || node.label;
    const artist = node.trackArtist || node.label.split(' - ')[1]?.replace(/\s*\(\d{4}\)$/, '') || '';
    const trackId = node.spotifyId || 'search';
    onAnalyzeTrack(trackId, title, artist);
  }, [onAnalyzeTrack]);

  const tabIds = { context: 'panel-context', player: 'panel-player', genealogy: 'panel-genealogy' } as const;

  return (
    <div className="h-full w-full flex flex-col bg-void relative overflow-hidden">
      {/* Background Atmosphere */}
      {track.coverUrl && (
        <img src={track.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-10 blur-3xl scale-110 pointer-events-none" />
      )}

      {/* Navigation (P0:3 — New Search button) */}
      <div className="z-20 px-6 py-4 flex items-center justify-between border-b border-white/5 bg-void/50 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={14} />} onClick={onBack}>
            BACK TO BASE<span className="hidden lg:inline text-text-muted text-[10px] ml-1">Esc</span>
          </Button>
          {onNewSearch && (
            <Button variant="ghost" size="sm" leftIcon={<Search size={12} />} onClick={onNewSearch}>
              NEW SEARCH
            </Button>
          )}
        </div>
        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-cyber">
            <span>DEEP_DIVE_MODE // {track.bpm} BPM {track.key && `// ${track.key}`}</span>
            <EstimatedWarning show={track.audioConfidence === 'low' || track.audioSource === 'estimated'} />
        </div>
      </div>

      {/* Main Content Triptych */}
      <div className="flex-1 relative z-10 flex flex-col md:flex-row overflow-hidden">

        {/* Panel A: Context (Desktop: Left, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.context}
          role="tabpanel"
          aria-labelledby="tab-context"
          className={`
            md:w-1/4 p-6 border-r border-white/5 bg-black/25 backdrop-blur-sm overflow-y-auto overscroll-contain
            ${activeTab === 'context' ? 'block absolute inset-0 md:static z-20 bg-void md:bg-transparent' : 'hidden md:block'}
        `}>
            <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-widest mb-1">Agent Analysis</h3>
            {allFactoids.length > 0 && (
              <p className="text-xs text-text-tertiary font-mono mb-8">{allFactoids.length} insights decoded</p>
            )}
            {allFactoids.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-12">
                <p className="text-text-tertiary text-xs font-mono text-center">AWAITING INTEL... No insights decoded for this track.</p>
              </div>
            ) : (
            <div className="space-y-6">
                {visibleFactoids.map((fact, idx) => (
                    <div key={fact.id} className={`stagger-${Math.min(idx + 1, 8)}`}>
                    <InteractiveFactoid
                        factoid={fact}
                        onEntityClick={handleEntityClick}
                    />
                    </div>
                ))}

                {/* Standalone Decrypt More card */}
                {onDecryptMoreStream && (
                  <button
                    onClick={handleDecryptMore}
                    disabled={isDecrypting}
                    className="w-full flex items-center justify-center gap-2 py-3 px-4
                               border border-dashed border-cyber/30 rounded-[--radius-md]
                               text-xs font-mono text-cyber/70 uppercase tracking-wider
                               hover:border-cyber hover:text-cyber hover:bg-cyber/5
                               focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none
                               disabled:opacity-50 disabled:cursor-wait
                               transition-all duration-[--duration-fast]"
                  >
                    {isDecrypting ? (
                      <>
                        <Lock size={12} className="animate-pulse" />
                        DECRYPTING...
                      </>
                    ) : (
                      <>
                        <Unlock size={12} />
                        [ DECRYPT MORE ]
                      </>
                    )}
                  </button>
                )}

                {/* Show more / collapse toggle */}
                {hiddenCount > 0 && !showAllFactoids && (
                  <div className="relative">
                    {/* Gradient fade on boundary */}
                    <div className="absolute -top-12 left-0 right-0 h-12 bg-gradient-to-b from-transparent to-black/20 pointer-events-none" />
                    <button
                      onClick={() => setShowAllFactoids(true)}
                      className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none transition-colors"
                    >
                      <ChevronDown size={14} />
                      Reveal {hiddenCount} hidden insights
                    </button>
                  </div>
                )}
                {showAllFactoids && allFactoids.length > INITIAL_VISIBLE_FACTOIDS && (
                  <button
                    onClick={() => setShowAllFactoids(false)}
                    className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber transition-colors focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none"
                  >
                    <ChevronDown size={14} className="rotate-180" />
                    Show less
                  </button>
                )}
            </div>
            )}

            {/* P3:25 — Decrypt complete toast */}
            {showDecryptToast && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 bg-cyber/10 border border-cyber/30 rounded-[--radius-sm] text-cyber text-xs font-mono tracking-widest animate-slide-up-fade shadow-glow-cyber-subtle">
                {decryptToastCount} NEW INTEL DECODED
              </div>
            )}
        </div>

        {/* Panel B: Artifact/Player (Desktop: Center, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.player}
          role="tabpanel"
          aria-labelledby="tab-player"
          className={`
            md:w-2/4 p-8 flex flex-col items-center justify-start relative overflow-y-auto overscroll-contain
            ${activeTab === 'player' ? 'block h-full' : 'hidden md:flex'}
        `}>
             {/* Album Art Container */}
             <div className="relative w-56 h-56 md:w-64 md:h-64 lg:w-80 lg:h-80 mb-8 mt-4 group flex-shrink-0">
                 <div className="absolute inset-0 bg-cyber/15 blur-3xl rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-[--duration-dramatic]"></div>
                 {track.coverUrl ? (
                   <img
                      src={track.coverUrl}
                      alt="Album Art"
                      className={`w-full h-full object-cover rounded-[--radius-lg] shadow-elevated-lg relative z-10 border border-white/10 transition-all duration-[--duration-dramatic] ${isPlaying ? 'animate-pulse-slow shadow-[var(--shadow-glow-cyber)]' : ''}`}
                   />
                 ) : (
                   <div className={`w-full h-full rounded-[--radius-lg] shadow-elevated-lg relative z-10 border border-white/10 bg-gray-900 flex items-center justify-center transition-all duration-[--duration-dramatic] ${isPlaying ? 'animate-pulse-slow' : ''}`}>
                     <Music size={64} className="text-text-muted" />
                   </div>
                 )}
             </div>

             {/* Meta */}
             <div className="text-center mb-6">
                 <h1 ref={headingRef} tabIndex={-1} className="text-3xl md:text-4xl font-light leading-[--leading-tight] text-white tracking-[--tracking-tight] mb-2 text-shadow-dark outline-none">{track.title}</h1>
                 <p className="text-lg text-text-tertiary font-mono">{track.artist}</p>
                 {track.album && (
                   <div className="flex items-center justify-center gap-2 text-sm text-text-tertiary mt-1">
                     <span>{track.album}</span>
                     {track.releaseYear && (
                       <>
                         <span className="text-text-tertiary">•</span>
                         <span>{track.releaseYear}</span>
                       </>
                     )}
                   </div>
                 )}
                 {/* Audio Stats */}
                 <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
                   {track.bpm != null && (
                     <Badge variant="cyber">
                       {track.bpm} BPM
                     </Badge>
                   )}
                   {track.key && (
                     <Badge variant="cyber">
                       {track.key}
                     </Badge>
                   )}
                   {track.valence !== undefined && (
                     <Badge variant="gray" icon={<Heart size={10} className={track.valence > 0.5 ? "text-accent-pink" : "text-accent-blue"} />} title="Mood">
                       <span className={track.valence > 0.5 ? "text-accent-pink" : "text-accent-blue"}>
                         {track.valence > 0.7 ? "Euphoric" : track.valence > 0.5 ? "Upbeat" : track.valence > 0.3 ? "Mellow" : "Melancholic"}
                       </span>
                     </Badge>
                   )}
                   {track.danceability !== undefined && (
                     <Badge variant="gray" icon={<Disc size={10} className="text-analog" />} title="Danceability">
                       <span className="text-analog">{Math.round(track.danceability * 100)}%</span>
                     </Badge>
                   )}
                   <EstimatedWarning show={track.audioConfidence === 'low' || track.audioSource === 'estimated'} />
                 </div>
                 {/* Spotify Link */}
                 {track.spotifyUrl && (
                   <a
                     href={track.spotifyUrl}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="inline-flex items-center gap-1.5 mt-3 text-xs text-spotify hover:text-spotify transition-colors"
                   >
                     <ExternalLink size={12} />
                     <span>Open in Spotify</span>
                   </a>
                 )}
             </div>

             {/* Controls (P0:4 — removed Plus/Share, P0:7 — real audio playback) */}
             <div className="flex items-center justify-center gap-8 mb-6">
                 {track.previewUrl ? (
                   <button
                      onClick={handlePlayPause}
                      className={`w-16 h-16 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 hover:shadow-[var(--shadow-glow-white-hover)] hover:ring-2 hover:ring-white/20 active:scale-95 transition-all duration-[--duration-fast] ease-[--ease-spring] shadow-[var(--shadow-glow-white)] ${isPlaying ? 'animate-[glow-breathe-white_3s_ease-in-out_infinite]' : ''}`}
                      aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
                   >
                      {isPlaying ? <Pause size={28} fill="black" /> : <Play size={28} fill="black" className="ml-1" />}
                   </button>
                 ) : (
                   <span className="text-xs font-mono text-text-tertiary px-3 py-1.5 border border-white/10 rounded">
                     Preview unavailable
                   </span>
                 )}
             </div>

             {/* Smart Timeline with Key Moments */}
             <div className="w-full max-w-lg">
                <SmartTimeline
                  segments={track.segments}
                  duration={track.durationSeconds || 100}
                  samples={track.samples}
                  keyMoments={track.keyMoments}
                />
             </div>
        </div>

        {/* Panel C: Genealogy (Desktop: Right, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.genealogy}
          role="tabpanel"
          aria-labelledby="tab-genealogy"
          className={`
            md:w-1/4 border-l border-white/5 bg-black/25 backdrop-blur-sm relative
            ${activeTab === 'genealogy' ? 'block absolute inset-0 md:static z-20 bg-void md:bg-transparent' : 'hidden md:block'}
        `}>
            <div className="absolute top-4 left-4 z-10 pointer-events-none hidden md:block">
                 <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">Genealogy Network</h3>
            </div>
            {track.genealogy?.nodes && track.genealogy.nodes.length > 1 ? (
              <GenealogyGraph
                data={track.genealogy}
                onNodeClick={handleNodeClick}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center h-full p-6">
                <p className="text-text-tertiary text-xs font-mono text-center">NO CONNECTIONS MAPPED. This track's network is still uncharted.</p>
              </div>
            )}
            <div className="absolute bottom-4 right-4 z-10 text-right pointer-events-none hidden md:block">
                <p className="text-[10px] text-text-tertiary font-mono">D3.JS FORCE SIMULATION</p>
                <p className="text-[10px] text-cyber font-mono">INTERACTIVE: ENABLED</p>
            </div>
        </div>

      </div>

      {/* Mobile Tab Bar (P1:12 — ARIA roles) */}
      <div
        role="tablist"
        aria-label="Player sections"
        className="md:hidden border-t border-white/5 bg-void/90 backdrop-blur-lg flex text-xs font-mono uppercase tracking-widest pb-[env(safe-area-inset-bottom)]"
      >
          <button
            role="tab"
            id="tab-context"
            aria-selected={activeTab === 'context'}
            aria-controls={tabIds.context}
            onClick={() => setActiveTab('context')}
            className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'context' ? 'text-cyber border-t-2 border-cyber' : 'text-text-tertiary'}`}
          >
              Analysis
          </button>
          <button
            role="tab"
            id="tab-player"
            aria-selected={activeTab === 'player'}
            aria-controls={tabIds.player}
            onClick={() => setActiveTab('player')}
            className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'player' ? 'text-white border-t-2 border-white' : 'text-text-tertiary'}`}
          >
              Player
          </button>
          <button
            role="tab"
            id="tab-genealogy"
            aria-selected={activeTab === 'genealogy'}
            aria-controls={tabIds.genealogy}
            onClick={() => setActiveTab('genealogy')}
            className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'genealogy' ? 'text-analog border-t-2 border-analog' : 'text-text-tertiary'}`}
          >
              Network
          </button>
      </div>
    </div>
  );
};

export default Player;
