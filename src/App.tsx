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
          width: { ideal: 1920 }, // Higher res for better OCR
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

    // Grayscale + High Contrast
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Grayscale
      let v = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      // Increased Contrast / Thresholding
      // MTG card names are usually dark on light or light on dark
      // We aim for black text on white background
      v = v > 140 ? 255 : 0;

      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setLoading(true);
    setError(null);
    setDebugText('Processando imagem...');

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (context) {
      // Scale capture size
      const scanWidth = 600; // Increased for better OCR
      const scanHeight = 120;

      canvas.width = scanWidth;
      canvas.height = scanHeight;

      // Card name is usually at the top
      // We take a wider area to be sure
      const sx = (video.videoWidth - scanWidth * (video.videoWidth / 1280)) / 2;
      const sy = video.videoHeight * 0.12;
      const sWidth = scanWidth * (video.videoWidth / 1280);
      const sHeight = scanHeight * (video.videoHeight / 720);

      context.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, scanWidth, scanHeight);
      preprocessImage(context, scanWidth, scanHeight);

      try {
        const worker = await createWorker('eng');
        const { data: { text, confidence } } = await worker.recognize(canvas);
        await worker.terminate();

        const cleanedText = text.trim().replace(/[^a-zA-Z\s]/g, ' ').replace(/\s+/g, ' ');
        setDebugText(`${cleanedText} (${confidence}%)`);

        if (cleanedText.length > 3 && confidence > 20) {
          await searchCard(cleanedText);
        } else {
          setError('Texto muito confuso. Tente aproximar mais a câmera do nome da carta.');
        }
      } catch (err) {
        setError('Erro no processamento OCR.');
        console.error(err);
      }
    }
    setLoading(false);
  };

  const searchCard = async (name: string) => {
    try {
      // First try to autocomplete to find a close match
      const autoResponse = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`);
      const autoData = await autoResponse.json();

      let targetName = name;
      if (autoData.data && autoData.data.length > 0) {
        targetName = autoData.data[0]; // Use the most likely name
      }

      const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(targetName)}`);
      if (!response.ok) throw new Error('Carta não encontrada');

      const data = await response.json();

      // Always look for PT version if current is EN
      if (data.lang !== 'pt') {
        const ptResponse = await fetch(`https://api.scryfall.com/cards/search?q=!"${data.name}"+lang:pt`);
        if (ptResponse.ok) {
          const ptData = await ptResponse.json();
          if (ptData.data && ptData.data.length > 0) {
            setResult({ ...ptData.data[0], translated_text: undefined });
            return;
          }
        }
      }

      setResult({ ...data, translated_text: undefined });
    } catch (err) {
      setError('Carta não identificada com clareza. Tente novamente.');
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
    } catch (err) {
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
              <div className="scan-area" style={{ width: '320px', height: '80px' }}></div>
              <div style={{ marginTop: '20px', color: 'white', background: 'rgba(0,0,0,0.6)', padding: '5px 15px', borderRadius: '20px', fontSize: '0.9rem' }}>
                Enquadre o nome da carta no topo
              </div>
            </div>

            <div className="controls">
              <button
                className="btn-primary"
                onClick={captureAndScan}
                disabled={loading}
              >
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
                <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '300px' }} />
                <div style={{ fontSize: '10px', color: '#fff', padding: '4px', textAlign: 'center' }}>VISÃO DO SCANNER (Contraste Ativo)</div>
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {error && (
        <div style={{ position: 'fixed', top: '100px', left: '20px', right: '20px', background: 'var(--accent-red)', padding: '12px', borderRadius: '8px', zIndex: 200, fontSize: '0.85rem', boxShadow: '0 4px 15px rgba(0,0,0,0.4)' }}>
          {error}
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              {result.lang === 'pt' ? (
                <span className="translation-badge">Tradução Oficial</span>
              ) : (
                <span className="translation-badge badge-auto">Tradução Automática</span>
              )}
              <h2 style={{ fontSize: '1.25rem', marginTop: '4px' }}>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}>
              <X size={24} />
            </button>
          </div>

          <div className="card-text">
            {result.translated_text || result.printed_text || result.oracle_text || 'Carregando...'}
          </div>

          {result.image_uris && (
            <div style={{ width: '100%', maxHeight: '40vh', overflow: 'hidden', borderRadius: '12px' }}>
              <img
                src={result.image_uris.normal}
                alt={result.name}
                style={{ width: '100%', objectFit: 'contain' }}
              />
            </div>
          )}

          {result.lang !== 'pt' && !result.translated_text && (
            <div style={{ marginTop: '16px' }}>
              <button className="btn-primary" style={{ width: '100%', fontSize: '0.9rem' }} onClick={translateText}>
                <Globe size={18} />
                Traduzir Texto da Carta
              </button>
            </div>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'var(--text-secondary)', fontSize: '0.7rem', whiteSpace: 'nowrap', background: 'rgba(0,0,0,0.5)', padding: '2px 10px', borderRadius: '10px' }}>
          OCR: {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
