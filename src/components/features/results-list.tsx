'use client';

import { RestaurantWithAnalysis } from '@/types';
import { RestaurantCard } from './restaurant-card';

interface ResultsListProps {
  results: RestaurantWithAnalysis[];
  message: string;
}

export function ResultsList({ results, message }: ResultsListProps) {
  if (results.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          😕 Aradığınız kriterlere uygun mekan bulunamadı.
        </p>
        <p className="mt-2 text-sm text-zinc-500">
          Farklı bir yemek türü deneyin.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-12">
      {/* AI Message */}
      {message && (
        <div className="mb-8 rounded-xl bg-orange-50 p-4 dark:bg-orange-900/20">
          <p className="text-lg text-zinc-700 dark:text-zinc-300">
            🤖 {message}
          </p>
        </div>
      )}

      {/* Results Header */}
      <div className="mb-6 flex items-center justify-between">
        <h3 className="text-xl font-semibold text-zinc-900 dark:text-white">
          En İyi {results.length} Öneri
        </h3>
        <span className="text-sm text-zinc-500">
          Yemek puanına göre sıralı
        </span>
      </div>

      {/* Restaurant Cards */}
      <div className="space-y-4">
        {results.map((restaurant, index) => (
          <RestaurantCard
            key={restaurant.id}
            restaurant={restaurant}
            rank={index + 1}
          />
        ))}
      </div>
    </div>
  );
}
