import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, Eye, AlertCircle, Repeat, Zap, ZoomIn } from 'lucide-react';

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
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraIndex, setActiveCameraIndex] = useState(0);
  const [flashlight, setFlashlight] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<any>(null);

  // Initialize OCR Worker
  useEffect(() => {
    let active = true;
    const initWorker = async () => {
      try {
        const worker = await createWorker('eng');
        if (active) {
          workerRef.current = worker;
          setWorkerReady(true);
        }
      } catch (err) {
        if (active) setError("Erro ao carregar OCR.");
      }
    };
    initWorker();

    // Get available cameras
    const getCameras = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);
      } catch (e) { }
    };
    getCameras();

    return () => {
      active = false;
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const startCamera = async (index: number = activeCameraIndex) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }

    setError(null);
    try {
      const constraints: any = {
        video: {
          deviceId: cameras[index]?.deviceId ? { exact: cameras[index].deviceId } : undefined,
          facingMode: cameras[index]?.deviceId ? undefined : 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setIsScanning(true);

      // Try to enable focus track if supported
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities() as any;
      if (capabilities.focusMode) {
        await track.applyConstraints({ focusMode: 'continuous' } as any);
      }

    } catch (err) {
      setError('Acesso à câmera negado ou lente indisponível.');
    }
  };

  const switchLens = () => {
    const nextIndex = (activeCameraIndex + 1) % cameras.length;
    setActiveCameraIndex(nextIndex);
    if (isScanning) startCamera(nextIndex);
  };

  const toggleFlashlight = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    try {
      await track.applyConstraints({
        advanced: [{ torch: !flashlight }]
      } as any);
      setFlashlight(!flashlight);
    } catch (e) {
      setError("Lanterna não suportada nesta lente.");
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

  const preprocessImage = (ctx: CanvasRenderingContext2D, width: number, height: number, threshold: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = (0.34 * data[i] + 0.5 * data[i + 1] + 0.16 * data[i + 2]);
      const v = gray > threshold ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !canvasRef.current || !workerRef.current) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      // Capture Size
      const size = 1000;
      canvas.width = size;
      canvas.height = size;

      // Digital Zoom Crop
      const zoomFactor = zoomLevel;
      const sSize = (video.videoWidth / zoomFactor) * (1000 / 1280); // Relative to baseline
      const sx = (video.videoWidth - sSize) / 2;
      const sy = (video.videoHeight - sSize) / 2;

      // We will try 3 different thresholds to catch text
      const thresholds = [100, 130, 160];
      let bestResult = null;

      for (const thr of thresholds) {
        setDebugText(`Tentativa (Limiar ${thr})...`);
        context.drawImage(video, sx, sy, sSize, sSize, 0, 0, size, size);
        preprocessImage(context, size, size, thr);

        const { data: { text } } = await workerRef.current.recognize(canvas);
        const lines = text.split('\n')
          .map(l => l.trim().replace(/[^a-zA-Z\s]/g, ''))
          .filter(l => l.length > 4);

        if (lines.length > 0) {
          const found = await searchMultipleFuzzy(lines.slice(0, 5));
          if (found) {
            bestResult = found;
            break;
          }
        }
      }

      if (!bestResult) {
        setError('Não consegui identificar a carta. Experimente trocar a lente ou ligar a lanterna.');
      }
    } catch (err) {
      setError('Erro no processamento.');
    } finally {
      setLoading(false);
      setDebugText('');
    }
  };

  const searchMultipleFuzzy = async (lines: string[]) => {
    for (const query of lines) {
      try {
        const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(query)}`);
        if (res.ok) return await res.json();
      } catch (e) { }
    }
    return null;
  };

  useEffect(() => {
    if (result) fetchPTVersion(result);
  }, [result && result.name]);

  const fetchPTVersion = async (cardData: any) => {
    if (!cardData || cardData.lang === 'pt') return;
    try {
      const ptRes = await fetch(`https://api.scryfall.com/cards/search?q=!"${cardData.name}"+lang:pt`);
      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (ptData.data && ptData.data.length > 0) {
          setResult(ptData.data[0]);
        }
      }
    } catch (e) { }
  };

  const translateText = async () => {
    if (!result) return;
    setLoading(true);
    try {
      const text = result.oracle_text || result.printed_text || "";
      const resp = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`);
      const data = await resp.json();
      setResult({ ...result, translated_text: data[0].map((i: any) => i[0]).join('') });
    } catch (e) {
      setError('Falha na tradução.');
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
            <h1 style={{ marginBottom: '5px' }}>ScanMTG</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '30px' }}>Toque para começar</p>
            <button className="btn-primary" onClick={() => startCamera()} style={{ padding: '20px 40px' }}>
              <Camera size={28} />
              INICIAR
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted />

            <div className="scanner-overlay">
              <div className="scan-focus-corners">
                <div className="corner tl"></div><div className="corner tr"></div>
                <div className="corner bl"></div><div className="corner br"></div>
              </div>
            </div>

            <div className="camera-actions" style={{ position: 'absolute', right: '20px', top: '100px', display: 'flex', flexDirection: 'column', gap: '20px', pointerEvents: 'auto' }}>
              <button className="glass" onClick={switchLens} style={{ padding: '12px', borderRadius: '50%', color: 'white' }}>
                <Repeat size={24} />
              </button>
              <button className="glass" onClick={toggleFlashlight} style={{ padding: '12px', borderRadius: '50%', color: flashlight ? 'var(--accent-blue)' : 'white' }}>
                <Zap size={24} />
              </button>
              <button className="glass" onClick={() => setZoomLevel(zoomLevel === 1 ? 2 : 1)} style={{ padding: '12px', borderRadius: '50%', color: zoomLevel > 1 ? 'var(--accent-blue)' : 'white' }}>
                <ZoomIn size={24} />
              </button>
            </div>

            <div className="controls">
              <button className="btn-primary" onClick={captureAndScan} disabled={loading || !workerReady} style={{ transform: 'scale(1.1)' }}>
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'ANALISANDO...' : 'ESCANEAR'}
              </button>
              <button className="glass" style={{ color: '#fff', padding: '16px', borderRadius: '50%' }} onClick={stopCamera}>
                <X size={24} />
              </button>
            </div>
          </>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {error && (
        <div style={{ position: 'fixed', top: '80px', left: '25px', right: '25px', background: 'var(--accent-red)', color: '#fff', padding: '15px', borderRadius: '16px', zIndex: 200, textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
          <AlertCircle size={20} style={{ marginBottom: '5px' }} />
          <div style={{ fontSize: '0.85rem' }}>{error}</div>
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Tradução Oficial' : 'Tradução IA'}
              </span>
              <h2>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}><X size={20} /></button>
          </div>

          <div className="card-text">{result.translated_text || result.printed_text || result.oracle_text}</div>
          {result.image_uris && <img src={result.image_uris.normal} alt={result.name} style={{ width: '100%', borderRadius: '16px' }} />}

          {result.lang !== 'pt' && !result.translated_text && (
            <button className="btn-primary" style={{ width: '100%', marginTop: '15px' }} onClick={translateText}>
              <Globe size={18} /> Traduzir Texto
            </button>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.7)', fontSize: '0.65rem' }}>
          {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
