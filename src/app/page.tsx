'use client';

import { useState } from 'react';
import { SearchForm } from '@/components/features/search-form';
import { ResultsList } from '@/components/features/results-list';
import { RestaurantWithAnalysis } from '@/types';

export default function Home() {
  const [results, setResults] = useState<RestaurantWithAnalysis[]>([]);
  const [message, setMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (foodQuery: string, location: { latitude: number; longitude: number }) => {
    setIsLoading(true);
    setHasSearched(true);

    try {
      const response = await fetch('/api/ai/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foodQuery, location }),
      });

      const data = await response.json();

      if (data.success) {
        setResults(data.data.recommendations);
        setMessage(data.data.message);
      } else {
        setMessage('Bir hata oluştu. Lütfen tekrar deneyin.');
        setResults([]);
      }
    } catch (error) {
      console.error('Search error:', error);
      setMessage('Bağlantı hatası. Lütfen tekrar deneyin.');
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white dark:from-zinc-900 dark:to-zinc-950">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm dark:bg-zinc-900/80">
        <div className="mx-auto max-w-5xl px-4 py-4">
          <h1 className="text-2xl font-bold text-orange-600 dark:text-orange-500">
            🍽️ Nerede Yesem?
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            AI destekli yemek öneri sistemi
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* Hero Section */}
        {!hasSearched && (
          <div className="mb-12 text-center">
            <h2 className="mb-4 text-4xl font-bold text-zinc-900 dark:text-white">
              Ne yemek istiyorsun?
            </h2>
            <p className="mx-auto max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
              Yemek türünü yaz, biz sana en iyi mekanları bulalım.
              Yapay zeka ile yorumları analiz edip, gerçekten iyi olan yerleri öneriyoruz.
            </p>
          </div>
        )}

        {/* Search Form */}
        <SearchForm onSearch={handleSearch} isLoading={isLoading} />

        {/* Loading State */}
        {isLoading && (
          <div className="mt-12 text-center">
            <div className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
            <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
              Yorumlar analiz ediliyor... 🔍
            </p>
            <p className="text-sm text-zinc-500">
              AI en iyi mekanları seçiyor
            </p>
          </div>
        )}

        {/* Results */}
        {!isLoading && hasSearched && (
          <ResultsList results={results} message={message} />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white/50 dark:bg-zinc-900/50">
        <div className="mx-auto max-w-5xl px-4 py-6 text-center text-sm text-zinc-500">
          <p>Nerede Yesem? - AI Destekli Yemek Öneri Sistemi</p>
          <p className="mt-1">Powered by GPT-4o-mini</p>
        </div>
      </footer>
    </div>
  );
}
