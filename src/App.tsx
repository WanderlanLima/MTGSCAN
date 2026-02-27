import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, Eye } from 'lucide-react';

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<any>(null);

  // Initialize OCR Worker once
  useEffect(() => {
    const initWorker = async () => {
      const worker = await createWorker('eng');
      workerRef.current = worker;
    };
    initWorker();
    return () => {
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
    } catch (err) {
      setError('Não foi possível acessar a câmera.');
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
    // Enhanced Thresholding for Mixed Lighting
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const gray = (0.299 * r + 0.587 * g + 0.114 * b);
      const v = gray > 140 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) {
      if (!workerRef.current) setError("Scanner ainda carregando...");
      return;
    }

    setLoading(true);
    setError(null);
    setDebugText('Identificando...');

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (context) {
      const captureWidth = 800;
      const captureHeight = 1100;
      canvas.width = captureWidth;
      canvas.height = captureHeight;

      const sx = (video.videoWidth - captureWidth * (video.videoWidth / 1280)) / 2;
      const sy = (video.videoHeight - captureHeight * (video.videoHeight / 720)) / 2;
      const sWidth = captureWidth * (video.videoWidth / 1280);
      const sHeight = captureHeight * (video.videoHeight / 720);

      context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, captureWidth, captureHeight);
      preprocessImage(context, captureWidth, captureHeight);

      try {
        const { data: { text, confidence } } = await workerRef.current.recognize(canvas);

        // Strategy: Look for lines that look like card names (No numbers, capitalized)
        const lines = text.split('\n').map((l: string) => l.trim().replace(/[^a-zA-Z\s,]/g, '')).filter((l: string) => l.length > 3);

        setDebugText(`Confiança: ${confidence}% | Lendo: ${lines[0]?.substring(0, 10) || '...'}`);

        if (lines.length > 0) {
          // Send the top 3 potential lines to fuzzy search
          const found = await searchMultipleFuzzy(lines.slice(0, 3));
          if (!found) setError('Não reconheci esta carta. Tente focar melhor.');
        } else {
          setError('Nenhum texto legível encontrado.');
        }
      } catch (err) {
        setError('Erro na leitura.');
      }
    }
    setLoading(false);
  };

  const searchMultipleFuzzy = async (lines: string[]) => {
    for (const line of lines) {
      try {
        // Use autocomplete to refine the guess
        const autoRes = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(line)}`);
        const autoData = await autoRes.json();

        if (autoData.data && autoData.data.length > 0) {
          const guess = autoData.data[0];
          const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(guess)}`);
          if (res.ok) {
            const data = await res.json();
            await fetchPTVersion(data);
            return true;
          }
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
          setResult(ptData.data[0]);
          return;
        }
      }
      setResult({ ...cardData, translated_text: undefined });
    } catch {
      setResult({ ...cardData, translated_text: undefined });
    }
  };

  const translateText = async () => {
    if (!result || !result.oracle_text) return;
    setLoading(true);
    try {
      const resp = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(result.oracle_text)}`);
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
            <button className="btn-primary" onClick={startCamera}>
              <Camera size={24} />
              Abrir Scanner
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline />
            <div className="scanner-overlay">
              <div className="scan-focus-corners">
                <div className="corner tl"></div>
                <div className="corner tr"></div>
                <div className="corner bl"></div>
                <div className="corner br"></div>
              </div>
              <div style={{ marginTop: '20px', color: '#fff', fontSize: '0.9rem', backgroundColor: 'rgba(0,0,0,0.5)', padding: '5px 15px', borderRadius: '20px' }}>
                Aponte para qualquer carta
              </div>
            </div>

            <div className="controls">
              <button className="btn-primary" onClick={captureAndScan} disabled={loading}>
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'Identificando...' : 'Escanear'}
              </button>
              <button className="glass" style={{ color: '#fff', padding: '16px', borderRadius: '50%' }} onClick={() => setShowOCRPreview(!showOCRPreview)}>
                <Eye size={24} />
              </button>
              <button className="glass" style={{ color: '#fff', padding: '16px', borderRadius: '50%' }} onClick={stopCamera}>
                <X size={24} />
              </button>
            </div>

            {showOCRPreview && (
              <div style={{ position: 'absolute', top: '80px', left: '50%', transform: 'translateX(-50%)', zIndex: 60, background: '#000', border: '1px solid var(--accent-blue)', borderRadius: '8px' }}>
                <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '200px' }} />
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div style={{ position: 'fixed', top: '100px', left: '25px', right: '25px', background: 'var(--accent-red)', color: '#fff', padding: '12px', borderRadius: '12px', zIndex: 200, textAlign: 'center', boxShadow: '0 4px 15px rgba(0,0,0,0.5)' }}>
          {error}
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Tradução Oficial' : (result.translated_text ? 'IA Tradutor' : 'Original EN')}
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
            <img src={result.image_uris.normal} alt={result.name} style={{ width: '100%', borderRadius: '12px' }} />
          )}

          {result.lang !== 'pt' && !result.translated_text && (
            <div style={{ marginTop: '16px' }}>
              <button className="btn-primary" style={{ width: '100%' }} onClick={translateText}>
                <Globe size={18} />
                Traduzir Texto
              </button>
            </div>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.6)', fontSize: '0.6rem' }}>
          {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
