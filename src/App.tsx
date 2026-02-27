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
  set: string;
  collector_number: string;
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
  const [previewCanvas, setPreviewCanvas] = useState<string | null>(null);

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
      if (videoRef.current) videoRef.current.srcObject = stream;
      setIsScanning(true);
      setResult(null);
    } catch (err) {
      setError('Acesso à câmera negado.');
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
      await track.applyConstraints({ advanced: [{ torch: !flashlight }] } as any);
      setFlashlight(!flashlight);
    } catch (e) {
      setError("Lanterna não disponível nesta lente.");
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  };

  const processZone = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    // High contrast thresholding
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (0.34 * data[i] + 0.5 * data[i + 1] + 0.16 * data[i + 2]);
      const v = brightness > 125 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !workerRef.current) return;
    setLoading(true);
    setError(null);
    setDebugText('Focando...');

    const video = videoRef.current;
    const canvas = document.createElement('canvas'); // Temp canvas for processing
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    // We capture a high-res frame but focus our crops
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    // Pass 1: Card Title (Top 12%)
    const titleWidth = 800;
    const titleHeight = 100;
    canvas.width = titleWidth;
    canvas.height = titleHeight;

    const sx = (videoWidth - titleWidth * (videoWidth / 1280)) / 2;
    const sy = videoHeight * 0.12;
    const sw = titleWidth * (videoWidth / 1280);
    const sh = titleHeight * (videoHeight / 720);

    context.drawImage(video, sx, sy, sw, sh, 0, 0, titleWidth, titleHeight);
    processZone(context, titleWidth, titleHeight);

    if (showOCRPreview) setPreviewCanvas(canvas.toDataURL());

    try {
      setDebugText('Lendo título...');
      const { data: { text: titleText } } = await workerRef.current.recognize(canvas);

      // Pass 2: Collector Info (Bottom Left)
      const infoWidth = 400;
      const infoHeight = 80;
      canvas.width = infoWidth;
      canvas.height = infoHeight;
      const infoSx = sx; // Keep same horizontal alignment
      const infoSy = videoHeight * 0.82; // Bottom area

      context.drawImage(video, infoSx, infoSy, sw / 2, sh, 0, 0, infoWidth, infoHeight);
      processZone(context, infoWidth, infoHeight);

      setDebugText('Lendo rodapé...');
      const { data: { text } } = await workerRef.current.recognize(canvas);

      const lines = text.split('\n')
        .map((l: string) => l.trim().replace(/[^a-zA-Z\s]/g, ''))
        .filter((l: string) => l.length > 4);
      const infoMatch = text.match(/([A-Z0-9]{3,})\s*(\d+)/i);

      const cleanTitle = titleText.trim().replace(/[^a-zA-Z\s]/g, '');

      if (infoMatch) {
        setDebugText(`ID Encontrado: ${infoMatch[1]}/${infoMatch[2]}`);
        await searchByInfo(infoMatch[1], infoMatch[2]);
      } else if (cleanTitle.length > 3) {
        setDebugText(`Buscando Nome: ${cleanTitle.substring(0, 10)}...`);
        await searchByName(cleanTitle);
      } else {
        setError("Não consegui ler a carta. Tente focar no título ou no rodapé.");
      }

    } catch (err) {
      setError("Erro no Scanner.");
    } finally {
      setLoading(false);
      setDebugText('');
    }
  };

  const searchByInfo = async (set: string, num: string) => {
    try {
      const resp = await fetch(`https://api.scryfall.com/cards/${set.toLowerCase()}/${num}`);
      if (resp.ok) {
        const data = await resp.json();
        await fetchPTVersion(data);
      } else {
        setError("Info de rodapé não encontrada no banco. Tentando por nome...");
      }
    } catch (e) { }
  };

  const searchByName = async (name: string) => {
    try {
      const autoRes = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`);
      const autoData = await autoRes.json();
      const targetName = (autoData.data && autoData.data.length > 0) ? autoData.data[0] : name;

      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(targetName)}`);
      if (res.ok) {
        const data = await res.json();
        await fetchPTVersion(data);
      } else {
        setError("Carta não identificada.");
      }
    } catch (e) { }
  };

  const fetchPTVersion = async (cardData: any) => {
    if (cardData.lang === 'pt') {
      setResult(cardData);
      return;
    }
    try {
      const ptRes = await fetch(`https://api.scryfall.com/cards/search?q=!"${cardData.name}"+lang:pt`);
      if (ptRes.ok) {
        const ptData = await ptRes.json();
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
    if (!result) return;
    setLoading(true);
    try {
      const text = result.oracle_text || result.printed_text || "";
      const resp = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`);
      const data = await resp.json();
      setResult({ ...result, translated_text: data[0].map((i: any) => i[0]).join('') });
    } catch (e) {
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
            <h1 style={{ marginBottom: '10px' }}>ScanMTG</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '40px', fontSize: '0.9rem' }}>Scanner de alta precisão</p>
            <button className="btn-primary" onClick={() => startCamera()} style={{ padding: '22px 50px', fontSize: '1.2rem' }}>
              <Camera size={28} />
              INICIAR SCANNER
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="scanner-overlay">
              <div className="scan-focus-corners" style={{ width: '280px', height: '400px' }}>
                <div className="corner tl"></div><div className="corner tr"></div>
                <div className="corner bl"></div><div className="corner br"></div>
              </div>
              <div className="guide-text" style={{ marginTop: '20px', color: '#fff', fontSize: '0.8rem', background: 'rgba(0,0,0,0.6)', padding: '10px 20px', borderRadius: '30px' }}>
                Alinhe o <b>título</b> e o <b>rodapé</b> da carta
              </div>
            </div>

            <div className="camera-actions" style={{ position: 'absolute', right: '20px', top: '100px', display: 'flex', flexDirection: 'column', gap: '20px', pointerEvents: 'auto' }}>
              <button className="glass" onClick={switchLens} style={{ padding: '14px', borderRadius: '50%', color: 'white' }}>
                <Repeat size={24} />
              </button>
              <button className="glass" onClick={toggleFlashlight} style={{ padding: '14px', borderRadius: '50%', color: flashlight ? 'var(--accent-blue)' : 'white' }}>
                <Zap size={24} />
              </button>
              <button className="glass" onClick={() => setShowOCRPreview(!showOCRPreview)} style={{ padding: '14px', borderRadius: '50%', color: showOCRPreview ? 'var(--accent-blue)' : 'white' }}>
                <Eye size={24} />
              </button>
            </div>

            <div className="controls">
              <button className="btn-primary" onClick={captureAndScan} disabled={loading || !workerReady} style={{ transform: 'scale(1.2)' }}>
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'ANALISANDO...' : 'ESCANEAR'}
              </button>
              <button className="glass" style={{ color: '#fff', padding: '16px', borderRadius: '50%' }} onClick={stopCamera}>
                <X size={24} />
              </button>
            </div>

            {showOCRPreview && previewCanvas && (
              <div style={{ position: 'absolute', top: '90px', left: '20px', background: '#000', border: '1px solid var(--accent-blue)', borderRadius: '8px', overflow: 'hidden', zIndex: 60 }}>
                <img src={previewCanvas} style={{ display: 'block', maxWidth: '150px' }} alt="OCR Preview" />
                <div style={{ fontSize: '8px', color: '#fff', padding: '2px', textAlign: 'center' }}>VISÃO DO SCANNER</div>
              </div>
            )}
          </>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {error && (
        <div style={{ position: 'fixed', top: '100px', left: '25px', right: '25px', background: 'var(--accent-red)', color: '#fff', padding: '15px', borderRadius: '16px', zIndex: 200, textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
          <AlertCircle size={20} style={{ marginBottom: '5px' }} />
          <div style={{ fontSize: '0.85rem' }}>{error}</div>
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Tradução Oficial' : 'Tradução IA / Fallback'}
              </span>
              <h2>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.printed_type_line || result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}><X size={20} /></button>
          </div>
          <div className="card-text">{result.translated_text || result.printed_text || result.oracle_text}</div>
          {result.image_uris && <img src={result.image_uris.normal} alt={result.name} style={{ width: '100%', borderRadius: '16px' }} />}
          {result.lang !== 'pt' && !result.translated_text && (
            <button className="btn-primary" style={{ width: '100%', marginTop: '15px', borderRadius: '12px' }} onClick={translateText}>
              <Globe size={18} /> TRADUZIR TEXTO
            </button>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.8)', fontSize: '0.7rem', backgroundColor: 'rgba(0,0,0,0.5)', padding: '5px 15px', borderRadius: '20px' }}>
          {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
