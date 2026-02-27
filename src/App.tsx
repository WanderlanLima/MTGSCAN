import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, AlertCircle, Repeat, Zap, ZoomIn, ShieldCheck } from 'lucide-react';

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
  const [workerReady, setWorkerReady] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraIndex, setActiveCameraIndex] = useState(0);
  const [flashlight, setFlashlight] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
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
        if (active) setError("Scanner offline.");
      }
    };
    initWorker();

    // Check permission and list cameras
    const checkPermission = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        setHasPermission(true);
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);
      } catch (e) {
        setHasPermission(false);
      }
    };
    checkPermission();

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

    // Resilience Strategy: Try multiple constraints
    const constraintOptions = [
      // 1. High res with ideal device
      {
        video: {
          deviceId: cameras[index]?.deviceId ? { exact: cameras[index].deviceId } : undefined,
          width: { ideal: 1920 }, height: { ideal: 1080 },
          facingMode: 'environment'
        }
      },
      // 2. Standard res
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' } },
      // 3. Basic
      { video: true }
    ];

    let success = false;
    for (const constraints of constraintOptions) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setIsScanning(true);
        success = true;
        break;
      } catch (err) {
        console.warn("Failed constraints:", constraints, err);
      }
    }

    if (!success) {
      setError('Não foi possível ativar nenhuma câmera. Verifique se outra aba está usando a câmera.');
    }
  };

  const switchLens = () => {
    if (cameras.length < 2) return;
    const nextIndex = (activeCameraIndex + 1) % cameras.length;
    setActiveCameraIndex(nextIndex);
    startCamera(nextIndex);
  };

  const processImage = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const imgData = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const avg = (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
      const v = avg > 115 ? 255 : 0; // High contrast binarization
      imgData.data[i] = imgData.data[i + 1] = imgData.data[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
  };

  const captureAndScan = async () => {
    if (!videoRef.current || !workerRef.current) return;
    setLoading(true);
    setError(null);
    setDebugText('Processando...');

    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    // Dual Pass Capture
    const vW = video.videoWidth;
    const vH = video.videoHeight;

    try {
      // Zone 1: Title
      canvas.width = 800; canvas.height = 100;
      ctx.drawImage(video, vW * 0.1, vH * 0.1, vW * 0.8, vH * 0.12, 0, 0, 800, 100);
      processImage(ctx, 800, 100);
      const { data: { text: titleText } } = await workerRef.current.recognize(canvas);

      // Zone 2: Bottom Info
      canvas.width = 400; canvas.height = 80;
      ctx.drawImage(video, vW * 0.05, vH * 0.8, vW * 0.4, vH * 0.15, 0, 0, 400, 80);
      processImage(ctx, 400, 80);
      const { data: { text: infoText } } = await workerRef.current.recognize(canvas);

      const codes = infoText.match(/([A-Z0-9]{3,})\s*(\d+)/i);
      if (codes) {
        await searchBySet(codes[1], codes[2]);
      } else {
        const cleanTitle = titleText.trim().replace(/[^a-zA-Z\s]/g, '');
        if (cleanTitle.length > 3) await searchByName(cleanTitle);
        else setError("Imagem borrada. Tente afastar um pouco ou limpar a lente.");
      }
    } catch (e) {
      setError("Falha no scanner.");
    } finally {
      setLoading(false);
      setDebugText('');
    }
  };

  const searchBySet = async (set: string, num: string) => {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/${set.toLowerCase()}/${num}`);
      if (res.ok) await fetchPTVersion(await res.json());
      else await searchByName(set + " " + num); // Fallback
    } catch (e) { }
  };

  const searchByName = async (name: string) => {
    try {
      const auto = await (await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`)).json();
      const target = (auto.data && auto.data.length > 0) ? auto.data[0] : name;
      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(target)}`);
      if (res.ok) await fetchPTVersion(await res.json());
      else setError("Carta não encontrada.");
    } catch (e) { }
  };

  const fetchPTVersion = async (card: any) => {
    if (card.lang === 'pt') { setResult(card); return; }
    try {
      const ptRes = await fetch(`https://api.scryfall.com/cards/search?q=!"${card.name}"+lang:pt`);
      if (ptRes.ok) {
        const ptData = await ptRes.json();
        if (ptData.data && ptData.data.length > 0) {
          setResult(ptData.data[0]);
          return;
        }
      }
      setResult(card);
    } catch { setResult(card); }
  };

  const translate = async () => {
    if (!result) return;
    setLoading(true);
    try {
      const text = result.oracle_text || "";
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`);
      const d = await r.json();
      setResult({ ...result, translated_text: d[0].map((i: any) => i[0]).join('') });
    } catch (e) {
      setError("Tradução falhou.");
    } finally { setLoading(false); }
  };

  if (hasPermission === false) {
    return (
      <div className="app-container" style={{ padding: '40px', textAlign: 'center' }}>
        <AlertCircle size={48} color="var(--accent-red)" />
        <h2>Câmera Bloqueada</h2>
        <p>Por favor, permita o acesso à câmera nas configurações do seu navegador para usar o Scanner.</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>Recarregar Página</button>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="logo-overlay">
        <img src="/MTGSCAN/logo.png" className="logo-img" alt="logo" />
        <span className="logo-text">ScanMTG</span>
      </div>

      <div className="scanner-viewport">
        {!isScanning ? (
          <div className="scanner-overlay" style={{ pointerEvents: 'auto' }}>
            <img src="/MTGSCAN/pwa-192x192.png" style={{ width: '80px', borderRadius: '20px', marginBottom: '20px' }} />
            <button className="btn-primary" onClick={() => startCamera()} disabled={!workerReady}>
              {workerReady ? <Camera size={24} /> : <RefreshCw size={24} className="animate-spin" />}
              {workerReady ? 'ABRIR SCANNER' : 'CARREGANDO IA...'}
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted />
            <div className="scanner-overlay">
              <div className="scan-focus-corners" style={{ opacity: 0.4 }}>
                <div className="corner tl"></div><div className="corner tr"></div>
                <div className="corner bl"></div><div className="corner br"></div>
              </div>
            </div>

            <div className="camera-actions" style={{ position: 'absolute', right: '20px', top: '100px', display: 'flex', flexDirection: 'column', gap: '20px', pointerEvents: 'auto' }}>
              {cameras.length > 1 && (
                <button className="glass" onClick={switchLens} style={{ padding: '15px', borderRadius: '50%', color: 'white' }}>
                  <Repeat size={24} />
                </button>
              )}
              <button className="glass" onClick={toggleFlashlight} style={{ padding: '15px', borderRadius: '50%', color: flashlight ? 'var(--accent-blue)' : 'white' }}>
                <Zap size={24} />
              </button>
            </div>

            <div className="controls">
              <button className="btn-primary" onClick={captureAndScan} disabled={loading} style={{ transform: 'scale(1.1)' }}>
                {loading ? <RefreshCw size={24} className="animate-spin" /> : <Search size={24} />}
                {loading ? 'IDENTIFICANDO...' : 'ESCANEAR'}
              </button>
              <button className="glass" style={{ color: '#fff', padding: '16px', borderRadius: '50%' }} onClick={stopCamera}>
                <X size={24} />
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ position: 'fixed', bottom: '120px', left: '20px', right: '20px', background: 'var(--accent-red)', color: '#fff', padding: '12px', borderRadius: '12px', zIndex: 200, textAlign: 'center' }}>
          {error}
        </div>
      )}

      {result && (
        <div className={`card-result glass open`}>
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                {result.lang === 'pt' ? 'Original PT-BR' : 'Tradução IA'}
              </span>
              <h2>{result.printed_name || result.name}</h2>
              <div className="card-type">{result.type_line}</div>
            </div>
            <button className="close-btn" onClick={() => setResult(null)}><X size={20} /></button>
          </div>
          <div className="card-text">{result.translated_text || result.oracle_text}</div>
          {result.image_uris && <img src={result.image_uris.normal} alt="card" style={{ width: '100%', borderRadius: '12px' }} />}
          {result.lang !== 'pt' && !result.translated_text && (
            <button className="btn-primary" style={{ width: '100%', marginTop: '15px' }} onClick={translate}>
              <Globe size={18} /> TRADUZIR AGORA
            </button>
          )}
        </div>
      )}

      {debugText && (
        <div style={{ position: 'fixed', bottom: '110px', left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.7)', fontSize: '0.7rem' }}>
          {debugText}
        </div>
      )}
    </div>
  );
};

export default App;
