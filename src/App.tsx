import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, Eye, AlertCircle } from 'lucide-react';

interface CardData {
  name: string;
  printed_name?: string;
  type_line: string;
  printed_type_line?: string;
  oracle_text?: string;
  printed_text?: string;
  translated_text?: string;
  image_uris?: {
    normal: string;
  };
  lang: string;
}

const App: React.FC = () => {
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugText, setDebugText] = useState<string>('');
  const [showOCRPreview, setShowOCRPreview] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<any>(null);

  // Initialize OCR Worker
  useEffect(() => {
    let active = true;
    const initWorker = async () => {
      try {
        setDebugText('Iniciando motor de leitura...');
        const worker = await createWorker('eng', 1, {
          logger: m => {
            if (active && m.status === 'recognizing text') {
              setDebugText(`Lendo: ${Math.round(m.progress * 100)}%`);
            }
          }
        });
        if (active) {
          workerRef.current = worker;
          setWorkerReady(true);
          setDebugText('Scanner pronto!');
        }
      } catch (err) {
        if (active) {
          console.error("Worker error:", err);
          setError("Erro ao carregar motor de leitura. Verifique sua internet.");
        }
      }
    };
    initWorker();
    return () => {
      active = false;
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      streamRef.current = stream;
      setIsScanning(true);
      setResult(null);
    } catch (err) {
      setError('Acesso à câmera negado ou não suportado.');
    }
  };

  useEffect(() => {
    if (isScanning && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [isScanning]);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  };

  const preprocessImage = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    // Binarization
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (0.34 * data[i] + 0.5 * data[i + 1] + 0.16 * data[i + 2]);
      const v = brightness > 120 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    if (!workerReady || !workerRef.current) {
      setError("Motor de leitura ainda está carregando... aguarde um instante.");
      return;
    }

    setLoading(true);
    setError(null);
    setDebugText('Capturando imagem...');

    try {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const context = canvas.getContext('2d', { willReadFrequently: true });

      if (!context) throw new Error("Could not get context");

      // Capture full center area
      const captureSize = 1000;
      canvas.width = captureSize;
      canvas.height = captureSize;

      const sx = (video.videoWidth - captureSize * (video.videoWidth / 1280)) / 2;
      const sy = (video.videoHeight - captureSize * (video.videoHeight / 1280)) / 2;
      const sWidth = captureSize * (video.videoWidth / 1280);
      const sHeight = captureSize * (video.videoHeight / 1280);

      context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, captureSize, captureSize);
      preprocessImage(context, captureSize, captureSize);

      setDebugText('Processando OCR...');
      const { data: { text } } = await workerRef.current.recognize(canvas);

      // Look for lines that look like English MTG card names
      const lines = text.split('\n')
        .map((l: string) => l.trim().replace(/[^a-zA-Z\s]/g, ''))
        .filter((l: string) => l.length > 4);

      if (lines.length > 0) {
        setDebugText(`Buscando: ${lines[0].substring(0, 15)}...`);
        const found = await searchMultipleFuzzy(lines.slice(0, 5));
        if (!found) {
          setError('Carta não reconhecida. Tente melhorar a luz ou o foco.');
        }
      } else {
        setError('Não consegui ler nenhum texto na carta.');
      }
    } catch (err) {
      console.error(err);
      setError('Erro ao processar imagem. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const searchMultipleFuzzy = async (lines: string[]) => {
    for (const query of lines) {
      try {
        const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          await fetchPTVersion(data);
          return true;
        }
      } catch (e) { }
    }
    return false;
  };

  const fetchPTVersion = async (cardData: any) => {
    try {
      if (cardData.lang === 'pt') {
        setResult(cardData);
        return;
      }
      const ptRes = await fetch(`https://api.scryfall.com/cards/search?q=!"${cardData.name}"+lang:pt`);
      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (ptData.data && ptData.data.length > 0) {
          setResult({ ...ptData.data[0], original_en: cardData });
          return;
        }
      }
      setResult(cardData);
    } catch {
      setResult(cardData);
    }
  };

  const translateText = async () => {
    if (!result || (!result.oracle_text && !result.printed_text)) return;
    setLoading(true);
    try {
      const textToTranslate = result.oracle_text || result.printed_text || "";
      const resp = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(textToTranslate)}`);
      const data = await resp.json();
      const translated = data[0].map((item: any) => item[0]).join('');
      setResult({ ...result, translated_text: translated });
    } catch {
      setError('Erro ao traduzir.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="logo-overlay">
        <img src="/MTGSCAN/logo.png" className="logo-img" alt="ScanMTG" />
        <span className="logo-text">ScanMTG</span>
      </div>

      <div className="scanner-viewport">
        {!isScanning ? (
          <div className="scanner-overlay" style={{ pointerEvents: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '30px' }}>
              <h1 style={{ fontSize: '2rem', margin: '0' }}>ScanMTG</h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Traduza suas cartas num piscar de olhos</p>
            </div>
            <button className="btn-primary" onClick={startCamera}>
              <Camera size={24} />
              Abrir Scanner
            </button>
            {!workerReady && (
              <div style={{ marginTop: '20px', fontSize: '0.8rem', color: 'var(--accent-purple)' }} className="animate-pulse">
                Carregando inteligência artificial...
              </div>
            )}
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="scanner-overlay">
              <div className="scan-focus-corners">
                <div className="corner tl"></div>
                <div className="corner tr"></div>
                <div className="corner bl"></div>
                <div className="corner br"></div>
              </div>
              <div style={{ marginTop: '40px', color: '#fff', fontSize: '0.85rem', backgroundColor: 'rgba(0,0,0,0.6)', padding: '8px 20px', borderRadius: '30px', backdropFilter: 'blur(5px)' }}>
                Aponte para a carta e clique em Escanear
              </div>
            </div>

            <div className="controls">
              <button
                className="btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  captureAndScan();
                }}
                disabled={loading || !workerReady}
                style={{ minWidth: '180px' }}
              >
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'Lendo...' : 'ESCANEAR'}
              </button>
              <button
                className="glass"
                style={{ color: '#fff', padding: '16px', borderRadius: '50%' }}
                onClick={() => setShowOCRPreview(!showOCRPreview)}
              >
                <Eye size={24} />
              </button>
              <button
                className="glass"
                style={{ color: '#fff', padding: '16px', borderRadius: '50%' }}
                onClick={stopCamera}
              >
                <X size={24} />
              </button>
            </div>

            {showOCRPreview && (
              <div className="glass" style={{ position: 'absolute', top: '80px', left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '4px', borderRadius: '12px' }}>
                <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '150px', borderRadius: '8px' }} />
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {error && (
        <div style={{ position: 'fixed', top: '80px', left: '25px', right: '25px', background: 'var(--accent-red)', color: '#fff', padding: '15px', borderRadius: '16px', zIndex: 200, textAlign: 'center', display: 'flex', alignItems: 'center', gap: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
          <AlertCircle size={20} />
          <span style={{ flex: 1, fontSize: '0.85rem' }}>{error}</span>
          <X size={20} onClick={() => setError(null)} />
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div style={{ width: '40px', height: '4px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px', margin: '0 auto 15px' }}></div>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Tradução Oficial' : (result.translated_text ? 'IA Tradutor' : 'Scan Original (EN)')}
              </span>
              <h2>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}>
              <X size={20} />
            </button>
          </div>

          <div className="card-text">
            {result.translated_text || result.printed_text || result.oracle_text || 'Sem texto disponível.'}
          </div>

          {result.image_uris && (
            <img
              src={result.image_uris.normal}
              alt={result.name}
              style={{ width: '100%', borderRadius: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)', marginBottom: '10px' }}
            />
          )}

          {result.lang !== 'pt' && !result.translated_text && (
            <div style={{ marginTop: '16px' }}>
              <button
                className="btn-primary"
                style={{ width: '100%', borderRadius: '16px' }}
                onClick={translateText}
                disabled={loading}
              >
                {loading ? <RefreshCw size={20} className="animate-spin" /> : <Globe size={20} />}
                Traduzir agora para PT-BR
              </button>
            </div>
          )}
        </div>
      )}

      {debugText && !error && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.8)', fontSize: '0.7rem', backgroundColor: 'rgba(0,0,0,0.4)', padding: '4px 12px', borderRadius: '15px', backdropFilter: 'blur(3px)' }}>
          {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
