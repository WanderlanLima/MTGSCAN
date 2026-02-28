import React, { useState, useRef, useEffect } from 'react';
import { createWorker } from 'tesseract.js';
import { Camera, RefreshCw, X, Search, Globe, AlertCircle, Image as ImageIcon } from 'lucide-react';

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
  const [workerReady, setWorkerReady] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);

  const workerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        if (active) setError("Scanner offline. Verifique sua conexão.");
      }
    };
    initWorker();

    return () => {
      active = false;
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);
    setLoading(true);
    setDebugText('Processando imagem de alta qualidade...');

    // Load image for preview and OCR
    const reader = new FileReader();
    reader.onload = async (event) => {
      const imageData = event.target?.result as string;
      setCapturedImage(imageData);
      await processPhoto(imageData);
    };
    reader.readAsDataURL(file);
  };

  const processPhoto = async (imageSrc: string) => {
    if (!workerRef.current) return;

    try {
      const img = new Image();
      img.src = imageSrc;
      await img.decode();

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      // We process the original high-res image for better OCR
      // Pass 1: Card Title Zone (Top 15%)
      canvas.width = img.width;
      canvas.height = img.height * 0.15;
      ctx.drawImage(img, 0, 0, img.width, img.height * 0.15, 0, 0, canvas.width, canvas.height);

      // Pre-processing Title
      const titleData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < titleData.data.length; i += 4) {
        const avg = (titleData.data[i] + titleData.data[i + 1] + titleData.data[i + 2]) / 3;
        const v = avg > 110 ? 255 : 0;
        titleData.data[i] = titleData.data[i + 1] = titleData.data[i + 2] = v;
      }
      ctx.putImageData(titleData, 0, 0);

      setDebugText('Lendo título com precisão...');
      const { data: { text: titleText } } = await workerRef.current.recognize(canvas);

      // Pass 2: Collector Info Zone (Bottom 15%, Left Half)
      canvas.height = img.height * 0.15;
      ctx.drawImage(img, 0, img.height * 0.85, img.width * 0.5, img.height * 0.15, 0, 0, img.width * 0.5, canvas.height);

      setDebugText('Buscando DNA da carta (rodapé)...');
      const { data: { text: infoText } } = await workerRef.current.recognize(canvas);

      const codes = infoText.match(/([A-Z0-9]{3,})\s*(\d+)/i);
      if (codes) {
        await searchBySet(codes[1], codes[2]);
      } else {
        const cleanTitle = titleText.trim().replace(/[^a-zA-Z\s]/g, '');
        if (cleanTitle.length > 2) await searchByName(cleanTitle);
        else setError("Não consegui ler o nome. Verifique se a foto está bem iluminada e nítida.");
      }
    } catch (e) {
      setError("Erro ao processar a foto.");
    } finally {
      setLoading(false);
      setDebugText('');
    }
  };

  const searchBySet = async (set: string, num: string) => {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/${set.toLowerCase()}/${num}`);
      if (res.ok) await fetchPTVersion(await res.json());
      else {
        // Fallback to name search if set info is wrong
        setDebugText('Código não encontrado, tentando por nome...');
        const cleanTitle = debugText; // Placeholder logic
        await searchByName(set + " " + num);
      }
    } catch (e) { }
  };

  const searchByName = async (name: string) => {
    try {
      const auto = await (await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(name)}`)).json();
      const target = (auto.data && auto.data.length > 0) ? auto.data[0] : name;
      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(target)}`);
      if (res.ok) await fetchPTVersion(await res.json());
      else setError("Carta não encontrada no banco de dados.");
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

  return (
    <div className="app-container">
      <div className="logo-overlay">
        <img src="logo.png" className="logo-img" alt="logo" />
        <span className="logo-text">ScanMTG</span>
      </div>

      <main className="main-content">
        {!loading && !result && !capturedImage && (
          <div className="welcome-screen">
            <div className="hero-icon">
              <ImageIcon size={48} color="var(--accent-blue)" />
            </div>
            <h1>Scanner de Alta Precisão</h1>
            <p>Use a câmera nativa do seu celular para resultados profissionais.</p>

            <div className="tips-container">
              <div className="tip-item">✨ Foto nítida e bem iluminada</div>
              <div className="tip-item">📄 Título da carta legível</div>
              <div className="tip-item">🎯 Rodapé deve estar visível</div>
            </div>

            <button className="btn-primary main-scan-btn" onClick={() => fileInputRef.current?.click()}>
              <Camera size={24} />
              IDENTIFICAR CARTA
            </button>
          </div>
        )}

        {loading && (
          <div className="loading-state">
            <RefreshCw size={48} className="animate-spin" color="var(--accent-blue)" />
            <h2>{debugText || 'Analisando DNA da carta...'}</h2>
            <p>Isso pode levar alguns segundos devido à alta resolução.</p>
          </div>
        )}

        {result && (
          <div className="card-result-container">
            <div className={`card-result glass open`}>
              <div className="card-header">
                <div style={{ flex: 1 }}>
                  <span className={`translation-badge ${result.lang !== 'pt' ? 'badge-auto' : ''}`}>
                    {result.lang === 'pt' ? 'Original PT-BR' : 'Tradução IA / Oracle'}
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
                <button className="glass" style={{ flex: 1, padding: '12px' }} onClick={() => { setResult(null); setCapturedImage(null); fileInputRef.current?.click(); }}>
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
