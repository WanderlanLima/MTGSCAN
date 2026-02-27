import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe } from 'lucide-react';

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      setIsScanning(true);
    } catch (err) {
      setError('Não foi possível acessar a câmera. Verifique as permissões.');
      console.error(err);
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

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setLoading(true);
    setError(null);

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas.getContext('2d');

    if (context) {
      const scanWidth = 280;
      const scanHeight = 60;

      canvas.width = scanWidth;
      canvas.height = scanHeight;

      const sx = (video.videoWidth - scanWidth) / 2;
      const sy = video.videoHeight * 0.15;

      context.drawImage(video, sx, sy, scanWidth, scanHeight, 0, 0, scanWidth, scanHeight);

      const imageData = context.getImageData(0, 0, scanWidth, scanHeight);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const color = avg > 128 ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = color;
      }
      context.putImageData(imageData, 0, 0);

      try {
        const worker = await createWorker('eng');
        const { data: { text } } = await worker.recognize(canvas);
        await worker.terminate();

        const cleanedText = text.trim().replace(/[^a-zA-Z\s]/g, '');
        setDebugText(cleanedText);

        if (cleanedText.length > 3) {
          await searchCard(cleanedText);
        } else {
          setError('Não foi possível ler o nome da carta. Tente focar melhor no título.');
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
      const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error('Carta não encontrada');

      const data = await response.json();

      if (data.lang !== 'pt') {
        const ptResponse = await fetch(`https://api.scryfall.com/cards/search?q=!"${data.name}"+lang:pt`);
        if (ptResponse.ok) {
          const ptData = await ptResponse.json();
          if (ptData.data && ptData.data.length > 0) {
            setResult(ptData.data[0]);
            return;
          }
        }
      }

      setResult(data);
    } catch (err) {
      setError('Carta não encontrada no banco de dados Scryfall.');
    }
  };

  const translateText = async () => {
    if (!result || !result.oracle_text) return;
    setLoading(true);
    try {
      const textToTranslate = result.oracle_text;
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(textToTranslate)}`);
      const data = await response.json();
      const translated = data[0].map((item: any) => item[0]).join('');
      setResult({ ...result, translated_text: translated });
    } catch (err) {
      setError('Erro ao traduzir automaticamente.');
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
              <div className="scan-area"></div>
              <div style={{ marginTop: '20px', color: 'white', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
                Posicione o nome da carta no retângulo
              </div>
            </div>

            <div className="controls">
              <button
                className="btn-primary"
                onClick={captureAndScan}
                disabled={loading}
              >
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'Escaneando...' : 'Escanear Carta'}
              </button>
              <button
                className="glass"
                style={{ color: 'white', padding: '16px', borderRadius: '50%' }}
                onClick={stopCamera}
              >
                <X size={24} />
              </button>
            </div>
          </>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {error && (
        <div style={{ position: 'fixed', top: '80px', left: '20px', right: '20px', background: 'var(--accent-red)', padding: '12px', borderRadius: '8px', zIndex: 200, fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div>
              {result.lang === 'pt' ? (
                <span className="translation-badge">Tradução Oficial PT-BR</span>
              ) : (
                <span className="translation-badge badge-auto">Inglês (Tradução Indisponível)</span>
              )}
              <h2>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}>
              <X size={24} />
            </button>
          </div>

          <div className="card-text">
            {result.translated_text || result.printed_text || result.oracle_text || 'Sem texto de regras.'}
          </div>

          {result.image_uris && (
            <img
              src={result.image_uris.normal}
              alt={result.name}
              style={{ width: '100%', borderRadius: '12px', marginTop: '10px' }}
            />
          )}

          {result.lang !== 'pt' && !result.translated_text && (
            <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
              <button className="btn-primary" style={{ flex: 1, fontSize: '0.9rem' }} onClick={translateText}>
                <Globe size={18} />
                Traduzir Automaticamente
              </button>
            </div>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '100px', left: '20px', color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
          OCR Debug: {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
