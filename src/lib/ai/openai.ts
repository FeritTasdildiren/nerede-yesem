import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface RestaurantAnalysis {
  foodScore: number; // 1-10
  positivePoints: string[];
  negativePoints: string[];
  isRecommended: boolean;
  summary: string;
}

export async function analyzeReviews(
  restaurantName: string,
  foodQuery: string,
  reviews: string[]
): Promise<RestaurantAnalysis> {
  const prompt = `Sen bir yemek değerlendirme uzmanısın. Aşağıdaki "${restaurantName}" restoranının yorumlarını analiz et ve "${foodQuery}" hakkındaki değerlendirmeleri çıkar.

Yorumlar:
${reviews.map((r, i) => `${i + 1}. ${r}`).join('\n')}

SADECE JSON formatında yanıt ver:
{
  "foodScore": 1-10 arası puan,
  "positivePoints": ["olumlu nokta 1", "olumlu nokta 2"],
  "negativePoints": ["olumsuz nokta 1"],
  "isRecommended": true/false,
  "summary": "2 cümlelik özet"
}

ÖNEMLİ KURALLAR:
- Yorumlarda "${foodQuery}" doğrudan veya dolaylı olarak geçiyorsa, genel izlenime göre 1-10 arası bir puan VER. Detaylı değerlendirme olmasa bile yorumların genel tonundan puan çıkar.
- Yorumcular genel olarak memnunsa ve "${foodQuery}" bahsediliyorsa, en az 5 puan ver.
- foodScore: 0 SADECE yorumların hiçbirinde "${foodQuery}" ile ilgili en ufak bir bilgi yoksa kullan.`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Sen bir yemek değerlendirme uzmanısın. Sadece JSON formatında yanıt ver.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    return JSON.parse(content) as RestaurantAnalysis;
  } catch (error) {
    console.error('[AI] Analysis error:', error);
    return {
      foodScore: 0,
      positivePoints: [],
      negativePoints: [],
      isRecommended: false,
      summary: 'Analiz yapılamadı.',
    };
  }
}

export async function generateRecommendationMessage(
  foodQuery: string,
  topRestaurants: Array<{ name: string; score: number; summary: string }>
): Promise<string> {
  const prompt = `Kullanıcı "${foodQuery}" yemek istiyor. En iyi restoranları şöyle sıraladık:

${topRestaurants.map((r, i) => `${i + 1}. ${r.name} (Puan: ${r.score}/10) - ${r.summary}`).join('\n')}

Kullanıcıya samimi ve yardımcı bir dilde (Türkçe) bu önerileri sun. Kısa ve öz ol (max 3 cümle).`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 200,
    });

    return response.choices[0]?.message?.content || 'İşte sizin için en iyi öneriler!';
  } catch (error) {
    console.error('[AI] Message generation error:', error);
    return 'İşte sizin için en iyi öneriler!';
  }
}

export default openai;
