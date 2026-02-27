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
      setError('Não foi possível acessar a câmera. Verifique as permissões.');
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
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = (0.2126 * r + 0.7152 * g + 0.0722 * b) > 130 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setLoading(true);
    setError(null);
    setDebugText('Analisando carta...');

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (context) {
      // Whole Card Guide Area: 250x350
      // We'll capture a larger buffer to be safe
      const captureWidth = 400;
      const captureHeight = 560;

      canvas.width = captureWidth;
      canvas.height = captureHeight;

      const sx = (video.videoWidth - captureWidth * (video.videoWidth / 1280)) / 2;
      const sy = (video.videoHeight - captureHeight * (video.videoHeight / 720)) / 2;
      const sWidth = captureWidth * (video.videoWidth / 1280);
      const sHeight = captureHeight * (video.videoHeight / 720);

      context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, captureWidth, captureHeight);

      // OCR Zones:
      // Top Zone (Name): 0 to 15% of height
      const nameZone = { x: 10, y: 10, w: captureWidth - 20, h: 60 };
      // Bottom Zone (Collector Info): 85% to 100% of height, left side
      const infoZone = { x: 10, y: captureHeight - 60, w: 200, h: 50 };

      try {
        const worker = await createWorker('eng');

        // 1. Scan Name Zone
        const nameCanvas = document.createElement('canvas');
        nameCanvas.width = nameZone.w;
        nameCanvas.height = nameZone.h;
        const nameCtx = nameCanvas.getContext('2d')!;
        nameCtx.drawImage(canvas, nameZone.x, nameZone.y, nameZone.w, nameZone.h, 0, 0, nameZone.w, nameZone.h);
        preprocessImage(nameCtx, nameZone.w, nameZone.h);
        const { data: { text: nameText } } = await worker.recognize(nameCanvas);

        // 2. Scan Collector Info Zone
        const infoCanvas = document.createElement('canvas');
        infoCanvas.width = infoZone.w;
        infoCanvas.height = infoZone.h;
        const infoCtx = infoCanvas.getContext('2d')!;
        infoCtx.drawImage(canvas, infoZone.x, infoZone.y, infoZone.w, infoZone.h, 0, 0, infoZone.w, infoZone.h);
        preprocessImage(infoCtx, infoZone.w, infoZone.h);
        const { data: { text: infoText } } = await worker.recognize(infoCanvas);

        await worker.terminate();

        const cleanName = nameText.trim().replace(/[^a-zA-Z\s]/g, ' ');
        // Extract Set Code (3 chars) and Number (digits)
        const infoMatch = infoText.match(/([A-Z]{3})\s*(\d+)/i);
        const setCode = infoMatch ? infoMatch[1].toUpperCase() : null;
        const collectorNum = infoMatch ? infoMatch[2] : null;

        setDebugText(`Nome: ${cleanName.substring(0, 10)}... | Info: ${setCode || '?'}/${collectorNum || '?'}`);

        if (setCode && collectorNum) {
          await searchByInfo(setCode, collectorNum);
        } else if (cleanName.length > 3) {
          await searchByName(cleanName);
        } else {
          setError('Não consegui identificar a carta. Tente alinhar o rodapé.');
        }

      } catch (err) {
        setError('Erro no scanner.');
      }
    }
    setLoading(false);
  };

  const searchByInfo = async (set: string, num: string) => {
    try {
      const response = await fetch(`https://api.scryfall.com/cards/${set.toLowerCase()}/${num}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      await fetchPTVersion(data);
    } catch {
      // Fallback to name if set info fails
      setError('Informação de coleção lida, mas não encontrada. Refazendo por nome...');
    }
  };

  const searchByName = async (name: string) => {
    try {
      const autoResponse = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`);
      const autoData = await autoResponse.json();
      const targetName = (autoData.data && autoData.data.length > 0) ? autoData.data[0] : name;

      const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(targetName)}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      await fetchPTVersion(data);
    } catch {
      setError('Carta não reconhecida.');
    }
  };

  const fetchPTVersion = async (cardData: any) => {
    if (cardData.lang === 'pt') {
      setResult(cardData);
      return;
    }
    try {
      const ptResponse = await fetch(`https://api.scryfall.com/cards/search?q=!"${cardData.name}"+lang:pt`);
      if (ptResponse.ok) {
        const ptData = await ptResponse.json();
        if (ptData.data && ptData.data.length > 0) {
          setResult(ptData.data[0]);
          return;
        }
      }
      setResult(cardData);
    } catch {
      setResult(cardData);
    }
  };

  const translateText = async () => {
    if (!result || !result.oracle_text) return;
    setLoading(true);
    try {
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(result.oracle_text)}`);
      const data = await response.json();
      const translated = data[0].map((item: any) => item[0]).join('');
      setResult({ ...result, translated_text: translated });
    } catch {
      setError('Erro na tradução.');
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
              Iniciar Câmera
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline />
            <div className="scanner-overlay">
              <div className="scan-area-card">
                <div className="scan-zone-indicator zone-name"></div>
                <div className="scan-zone-indicator zone-info"></div>
              </div>
              <div style={{ marginTop: '40px', color: 'white', background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: '20px', fontSize: '0.8rem', textAlign: 'center', width: '80%' }}>
                Enquadre a carta inteira no guia.<br />Destaque o <b>topo</b> e o <b>rodapé</b>.
              </div>
            </div>

            <div className="controls">
              <button className="btn-primary" onClick={captureAndScan} disabled={loading}>
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'Lendo...' : 'Escanear'}
              </button>
              <button
                className="glass"
                style={{ color: 'white', padding: '16px', borderRadius: '50%', pointerEvents: 'auto' }}
                onClick={() => setShowOCRPreview(!showOCRPreview)}
              >
                <Eye size={24} />
              </button>
              <button
                className="glass"
                style={{ color: 'white', padding: '16px', borderRadius: '50%', pointerEvents: 'auto' }}
                onClick={stopCamera}
              >
                <X size={24} />
              </button>
            </div>

            {showOCRPreview && (
              <div style={{ position: 'absolute', top: '80px', left: '50%', transform: 'translateX(-50%)', zIndex: 60, background: '#000', border: '1px solid var(--accent-blue)', borderRadius: '8px', overflow: 'hidden' }}>
                <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '200px' }} />
                <div style={{ fontSize: '10px', color: '#fff', padding: '4px', textAlign: 'center' }}>VISÃO DO SCANNER</div>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div style={{ position: 'fixed', top: '100px', left: '20px', right: '20px', background: 'var(--accent-red)', padding: '12px', borderRadius: '8px', zIndex: 200, fontSize: '0.85rem', boxShadow: '0 4px 15px rgba(0,0,0,0.4)', textAlign: 'center' }}>
          {error}
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Tradução Oficial' : (result.translated_text ? 'Traduzido por IA' : 'Original em Inglês')}
              </span>
              <h2 style={{ fontSize: '1.25rem', marginTop: '4px' }}>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}>
              <X size={20} />
            </button>
          </div>

          <div className="card-text">
            {result.translated_text || result.printed_text || result.oracle_text || 'Sem texto.'}
          </div>

          {result.image_uris && (
            <img src={result.image_uris.normal} alt={result.name} style={{ width: '100%', borderRadius: '12px' }} />
          )}

          {result.lang !== 'pt' && !result.translated_text && (
            <div style={{ marginTop: '16px' }}>
              <button className="btn-primary" style={{ width: '100%', fontSize: '0.9rem' }} onClick={translateText}>
                <Globe size={18} />
                Traduzir Agora
              </button>
            </div>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.7)', fontSize: '0.6rem', whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.4)', padding: '2px 8px', borderRadius: '10px' }}>
          DEBUG: {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
