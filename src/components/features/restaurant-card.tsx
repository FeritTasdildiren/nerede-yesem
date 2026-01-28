'use client';

import { RestaurantWithAnalysis } from '@/types';

interface RestaurantCardProps {
  restaurant: RestaurantWithAnalysis;
  rank: number;
}

const priceRangeLabels = {
  budget: '💰',
  moderate: '💰💰',
  expensive: '💰💰💰',
  luxury: '💰💰💰💰',
};

export function RestaurantCard({ restaurant, rank }: RestaurantCardProps) {
  const { aiAnalysis } = restaurant;

  const scoreColor =
    aiAnalysis.foodScore >= 8
      ? 'bg-green-500'
      : aiAnalysis.foodScore >= 6
        ? 'bg-orange-500'
        : 'bg-red-500';

  const handleOpenGoogleMaps = () => {
    // Search for the place by name and address to open the actual Google Maps listing
    const query = encodeURIComponent(`${restaurant.name}, ${restaurant.address}, ${restaurant.city}`);
    const url = `https://www.google.com/maps/search/?api=1&query=${query}`;
    window.open(url, '_blank');
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-all hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800">
      <div className="flex">
        {/* Rank Badge */}
        <div className="flex w-16 items-center justify-center bg-zinc-100 dark:bg-zinc-700">
          <span className="text-2xl font-bold text-zinc-400">#{rank}</span>
        </div>

        {/* Content */}
        <div className="flex-1 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-lg font-semibold text-zinc-900 dark:text-white">
                {restaurant.name}
              </h4>
              <p className="text-sm text-zinc-500">
                {restaurant.district}, {restaurant.city} • {priceRangeLabels[restaurant.priceRange]}
                {restaurant.distance !== undefined && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                    📍 {restaurant.distance} km
                  </span>
                )}
              </p>
            </div>

            {/* AI Score */}
            <div className="flex flex-col items-center">
              <div
                className={`flex h-12 w-12 items-center justify-center rounded-full ${scoreColor} text-white`}
              >
                <span className="text-lg font-bold">{aiAnalysis.foodScore}</span>
              </div>
              <span className="mt-1 text-xs text-zinc-500">AI Puan</span>
            </div>
          </div>

          {/* AI Summary */}
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            {aiAnalysis.summary}
          </p>

          {/* Pros & Cons */}
          <div className="mt-3 flex gap-4">
            {aiAnalysis.positivePoints.length > 0 && (
              <div className="flex-1">
                <p className="text-xs font-medium text-green-600">Artılar:</p>
                <ul className="mt-1 space-y-1">
                  {aiAnalysis.positivePoints.slice(0, 2).map((point, i) => (
                    <li key={i} className="text-xs text-zinc-600 dark:text-zinc-400">
                      ✓ {point}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {aiAnalysis.negativePoints.length > 0 && (
              <div className="flex-1">
                <p className="text-xs font-medium text-red-600">Eksiler:</p>
                <ul className="mt-1 space-y-1">
                  {aiAnalysis.negativePoints.slice(0, 2).map((point, i) => (
                    <li key={i} className="text-xs text-zinc-600 dark:text-zinc-400">
                      ✗ {point}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={handleOpenGoogleMaps}
              className="flex-1 rounded-lg bg-orange-500 py-2 text-sm font-medium text-white transition-all hover:bg-orange-600"
            >
              🗺️ Google Maps'te Aç
            </button>
            {restaurant.phone && (
              <a
                href={`tel:${restaurant.phone}`}
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-all hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300"
              >
                📞 Ara
              </a>
            )}
          </div>

          {/* Google Rating */}
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
            <span>Google: ⭐ {restaurant.avgRating}</span>
            <span>•</span>
            <span>{restaurant.reviewCount} yorum</span>
          </div>
        </div>
      </div>
    </div>
  );
}
