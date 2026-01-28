'use client';

import { useState, useEffect, useRef } from 'react';

interface SearchFormProps {
  onSearch: (foodQuery: string, location: { latitude: number; longitude: number }) => void;
  isLoading: boolean;
}

interface LocationSuggestion {
  display_name: string;
  lat: string;
  lon: string;
}

const popularFoods = [
  'Lahmacun',
  'Döner',
  'Köfte',
  'Pizza',
  'Burger',
  'Pide',
  'İskender',
  'Tantuni',
];

export function SearchForm({ onSearch, isLoading }: SearchFormProps) {
  const [foodQuery, setFoodQuery] = useState('');
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [locationName, setLocationName] = useState<string>('');

  // Location search
  const [locationQuery, setLocationQuery] = useState('');
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSearchingLocation, setIsSearchingLocation] = useState(false);
  const suggestionRef = useRef<HTMLDivElement>(null);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionRef.current && !suggestionRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Search locations with debounce
  useEffect(() => {
    if (locationQuery.length < 3) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearchingLocation(true);
      try {
        // OpenStreetMap Nominatim API (ücretsiz)
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationQuery)}&countrycodes=tr&limit=5`,
          {
            headers: {
              'Accept-Language': 'tr',
            },
          }
        );
        const data = await response.json();
        setSuggestions(data);
        setShowSuggestions(true);
      } catch (error) {
        console.error('Location search error:', error);
        setSuggestions([]);
      } finally {
        setIsSearchingLocation(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [locationQuery]);

  const requestDeviceLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('error');
      return;
    }

    setLocationStatus('loading');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const coords = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setLocation(coords);
        setLocationStatus('success');

        // Reverse geocode to get address
        try {
          const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.latitude}&lon=${coords.longitude}`,
            {
              headers: {
                'Accept-Language': 'tr',
              },
            }
          );
          const data = await response.json();
          const address = data.address;
          const shortName = address.neighbourhood || address.suburb || address.district || address.city || 'Konum alındı';
          setLocationName(`${shortName} (${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)})`);
          setLocationQuery(shortName);
        } catch {
          setLocationName(`${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`);
        }
      },
      (error) => {
        console.error('Geolocation error:', error);
        setLocationStatus('error');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  };

  const selectSuggestion = (suggestion: LocationSuggestion) => {
    const coords = {
      latitude: parseFloat(suggestion.lat),
      longitude: parseFloat(suggestion.lon),
    };
    setLocation(coords);
    setLocationStatus('success');

    // Short name from display_name
    const parts = suggestion.display_name.split(',');
    const shortName = parts.slice(0, 2).join(',').trim();
    setLocationName(shortName);
    setLocationQuery(shortName);
    setShowSuggestions(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (foodQuery.trim() && location) {
      onSearch(foodQuery.trim(), location);
    }
  };

  const handleQuickSelect = (food: string) => {
    setFoodQuery(food);
    if (location) {
      onSearch(food, location);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Location Section */}
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-800">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">📍 Konum</span>
            {locationStatus === 'success' && locationName && (
              <span className="text-xs text-green-600">✓ {locationName}</span>
            )}
            {locationStatus === 'error' && (
              <span className="text-xs text-red-500">✗ Konum alınamadı</span>
            )}
          </div>

          <div className="flex gap-2">
            {/* Auto Location Button */}
            <button
              type="button"
              onClick={requestDeviceLocation}
              disabled={isLoading || locationStatus === 'loading'}
              className="shrink-0 rounded-lg bg-orange-500 px-4 py-3 text-sm font-medium text-white transition-all hover:bg-orange-600 disabled:opacity-50"
            >
              {locationStatus === 'loading' ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Alınıyor
                </span>
              ) : (
                '🎯 Konumumu Bul'
              )}
            </button>

            {/* Location Search Input */}
            <div className="relative flex-1" ref={suggestionRef}>
              <input
                type="text"
                value={locationQuery}
                onChange={(e) => {
                  setLocationQuery(e.target.value);
                  if (e.target.value.length >= 3) {
                    setShowSuggestions(true);
                  }
                }}
                onFocus={() => {
                  if (suggestions.length > 0) {
                    setShowSuggestions(true);
                  }
                }}
                placeholder="veya adres yazın..."
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm transition-all focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-600 dark:bg-zinc-700 dark:text-white"
              />

              {isSearchingLocation && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent inline-block" />
                </div>
              )}

              {/* Suggestions Dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-600 dark:bg-zinc-800">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => selectSuggestion(suggestion)}
                      className="w-full px-4 py-3 text-left text-sm hover:bg-orange-50 dark:hover:bg-zinc-700"
                    >
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {suggestion.display_name.split(',').slice(0, 3).join(',')}
                      </span>
                      <span className="ml-2 text-xs text-zinc-400">
                        ({parseFloat(suggestion.lat).toFixed(4)}, {parseFloat(suggestion.lon).toFixed(4)})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {locationStatus === 'error' && (
            <p className="mt-2 text-xs text-zinc-500">
              Konum izni verilmedi. Lütfen adres yazarak arayın.
            </p>
          )}
        </div>

        {/* Search Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={foodQuery}
            onChange={(e) => setFoodQuery(e.target.value)}
            placeholder="Ne yemek istiyorsun? (örn: lahmacun)"
            className="flex-1 rounded-xl border border-zinc-200 bg-white px-6 py-4 text-lg shadow-sm transition-all focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !foodQuery.trim() || !location}
            className="rounded-xl bg-orange-500 px-8 py-4 text-lg font-semibold text-white shadow-sm transition-all hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? '...' : 'Bul'}
          </button>
        </div>

        {/* Popular Foods */}
        <div className="flex flex-wrap justify-center gap-2">
          <span className="text-sm text-zinc-500">Popüler:</span>
          {popularFoods.map((food) => (
            <button
              key={food}
              type="button"
              onClick={() => handleQuickSelect(food)}
              disabled={isLoading || !location}
              className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-700 transition-all hover:border-orange-500 hover:text-orange-600 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {food}
            </button>
          ))}
        </div>

        {!location && (
          <p className="text-center text-sm text-orange-500">
            Aramak için önce konum seçin veya adres yazın
          </p>
        )}
      </form>
    </div>
  );
}
