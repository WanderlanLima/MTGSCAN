import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, AlertCircle, Image as ImageIcon, Sparkles } from 'lucide-react';

declare global {
  interface Window {
    cv: any;
  }
}

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
  const [result, setResult] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugText, setDebugText] = useState<string>('');
  const [cvReady, setCvReady] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  const workerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize OCR Worker & OpenCV Check
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
        if (active) setError("Scanner offline. Verifique sua conexão.");
      }
    };
    initWorker();

    const checkCV = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        setCvReady(true);
        clearInterval(checkCV);
      }
    }, 500);

    return () => {
      active = false;
      if (workerRef.current) workerRef.current.terminate();
      clearInterval(checkCV);
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);
    setLoading(true);
    setDebugText('Iniciando Visão Computacional...');

    const reader = new FileReader();
    reader.onload = async (event) => {
      const imageData = event.target?.result as string;
      setCapturedImage(imageData);
      await processWithVisualIdentity(imageData);
    };
    reader.readAsDataURL(file);
  };

  const processWithVisualIdentity = async (imageSrc: string) => {
    if (!workerRef.current || !cvReady) {
      setError("Sistema de visão ainda carregando...");
      setLoading(false);
      return;
    }

    try {
      const img = new Image();
      img.src = imageSrc;
      await img.decode();

      const cv = window.cv;
      const src = cv.imread(img);
      const dst = new cv.Mat();

      setDebugText('Detectando bordas da carta...');

      // 1. Pre-process for contour detection
      cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(dst, dst, new cv.Size(5, 5), 0);
      cv.Canny(dst, dst, 75, 200);

      // 2. Find contours
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(dst, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let cardContour = null;
      let maxArea = 0;

      for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area > 50000) { // Minimum area for a card
          const peri = cv.arcLength(cnt, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

          if (approx.rows === 4 && area > maxArea) {
            cardContour = approx;
            maxArea = area;
          } else {
            approx.delete();
          }
        }
      }

      if (cardContour) {
        setDebugText('Alinhando perspectiva...');
        const warped = warpCard(src, cardContour);
        await runOCROnWarped(warped);
        warped.delete();
      } else {
        // Fallback: Use central crop if no contour is found
        setDebugText('Bordas não detectadas. Usando modo manual...');
        await runOCROnWarped(src);
      }

      src.delete();
      dst.delete();
      contours.delete();
      hierarchy.delete();
      if (cardContour) cardContour.delete();

    } catch (e) {
      console.error(e);
      setError("Falha na visão computacional.");
      setLoading(false);
    }
  };

  const warpCard = (src: any, contour: any) => {
    const cv = window.cv;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: contour.data32S[i * 2], y: contour.data32S[i * 2 + 1] });
    }

    // Sort points: top-left, top-right, bottom-right, bottom-left
    pts.sort((a, b) => a.y - b.y);
    const top = pts.slice(0, 2).sort((a, b) => a.x - b.x);
    const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x);
    const sortedPts = [top[0], top[1], bottom[1], bottom[0]];

    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      sortedPts[0].x, sortedPts[0].y,
      sortedPts[1].x, sortedPts[1].y,
      sortedPts[2].x, sortedPts[2].y,
      sortedPts[3].x, sortedPts[3].y,
    ]);

    const dstW = 500;
    const dstH = 700;
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dstW, 0, dstW, dstH, 0, dstH]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH));

    srcPts.delete();
    dstPts.delete();
    M.delete();
    return warped;
  };

  const runOCROnWarped = async (warpedMat: any) => {
    const canvas = document.createElement('canvas');
    window.cv.imshow(canvas, warpedMat);

    // OCR Zone: Title Bar (Top 12%)
    const titleCanvas = document.createElement('canvas');
    titleCanvas.width = canvas.width;
    titleCanvas.height = canvas.height * 0.12;
    const tCtx = titleCanvas.getContext('2d')!;
    tCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height * 0.12, 0, 0, titleCanvas.width, titleCanvas.height);

    setDebugText('Identificando DNA visual...');
    const { data: { text } } = await workerRef.current.recognize(titleCanvas);
    const cleanName = text.trim().replace(/[^a-zA-Z\s]/g, '');

    if (cleanName.length > 2) {
      await searchByName(cleanName);
    } else {
      setError("Imagem muito escura ou borrada. Tente novamente.");
      setLoading(false);
    }
  };

  const searchByName = async (name: string) => {
    try {
      setDebugText(`Buscando: ${name.substring(0, 15)}...`);
      const auto = await (await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`)).json();
      const target = (auto.data && auto.data.length > 0) ? auto.data[0] : name;
      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(target)}`);
      if (res.ok) {
        const data = await res.json();
        await fetchPTVersion(data);
      } else {
        setError("Carta não reconhecida. Tente uma foto mais nítida.");
      }
    } catch (e) {
      setError("Erro na conexão com Scryfall.");
    } finally {
      setLoading(false);
      setDebugText('');
    }
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

  return (
    <div className="app-container">
      <header className="logo-overlay">
        <Sparkles size={28} color="var(--accent-blue)" />
        <span className="logo-text">ScanMTG <small style={{ fontSize: '0.6rem', opacity: 0.5 }}>OpenCV v2</small></span>
      </header>

      <main className="main-content">
        {!loading && !result && (
          <div className="welcome-screen">
            <div className="hero-icon">
              <ImageIcon size={48} color="var(--accent-blue)" />
            </div>
            <h1>Visão Computacional</h1>
            <p>O algoritmo agora detecta as bordas e alinha a carta automaticamente.</p>

            <div className="tips-container">
              <div className="tip-item">🔲 Tente enquadrar a carta inteira na foto</div>
              <div className="tip-item">💡 Evite reflexos fortes na arte</div>
              <div className="tip-item">🃏 Funciona com qualquer idioma</div>
            </div>

            <button className="btn-primary main-scan-btn" onClick={() => fileInputRef.current?.click()} disabled={!cvReady || !workerReady}>
              {cvReady ? <Camera size={24} /> : <RefreshCw size={24} className="animate-spin" />}
              {cvReady ? 'ESCANEAR CARTA' : 'CARREGANDO VISÃO...'}
            </button>
          </div>
        )}

        {loading && (
          <div className="loading-state">
            <RefreshCw size={48} className="animate-spin" color="var(--accent-blue)" />
            <h2>{debugText || 'Analisando...'}</h2>
            <p>Ajustando perspectiva e limpando ruídos.</p>
          </div>
        )}

        {result && (
          <div className="card-result-container">
            <div className={`card-result glass open`}>
              <div className="card-header">
                <div style={{ flex: 1 }}>
                  <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                    {result.lang === 'pt' ? 'Oficial PT-BR' : 'Tradução IA / Oracle'}
                  </span>
                  <h2>{result.printed_name || result.name}</h2>
                  <div className="card-type">{result.type_line}</div>
                </div>
                <button className="close-btn" onClick={() => { setResult(null); setCapturedImage(null); }}><X size={20} /></button>
              </div>
              <div className="card-text">{result.translated_text || result.oracle_text}</div>
              {result.image_uris && <img src={result.image_uris.normal} alt="card" className="card-image" />}

              <div className="action-buttons">
                {result.lang !== 'pt' && !result.translated_text && (
                  <button className="btn-primary" style={{ flex: 1 }} onClick={translate}>
                    <Globe size={18} /> TRADUZIR
                  </button>
                )}
                <button className="glass" style={{ flex: 1, padding: '12px', border: '1px solid var(--accent-blue)' }} onClick={() => { setResult(null); setCapturedImage(null); fileInputRef.current?.click(); }}>
                  <Camera size={18} /> NOVA FOTO
                </button>
              </div>
            </div>
          </div>
        )}

        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={fileInputRef}
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
      </main>

      {error && (
        <div className="error-toast">
          <AlertCircle size={20} />
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}
    </div>
  );
};

export default App;
