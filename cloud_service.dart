import 'dart:convert';
import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:minio/minio.dart';
import '../models/recipe_model.dart';

class CloudService {
  static final CloudService _instance = CloudService._internal();
  
  // Cache for full recipe details to avoid redundant network calls
  static final Map<String, Recipe> recipeCache = {};

  // GÜVENLİK: API KEY (Backend ile aynı olmalı)
  static const String _appApiKey = "chef-aykut-super-secret-2026-xyz";

  // YENİ: Dinamik API Base URL
  static String get _apiBaseUrl {
    // Force use production Render server for testing as local backend is offline
    return "https://chef-aykut-backend.onrender.com";
  }

  // Ortak Headerlar
  Map<String, String> get _headers => {
    "Content-Type": "application/json",
    "x-api-key": _appApiKey,
  };
  
  // Eski sabit IP (Fiziksel cihazda test edecekseniz bunu kullanın)
  static const String _manualApiUrl = "https://chef-aykut-backend.onrender.com";
  
  bool _isInitialized = true; // API tabanlı olduğu için her zaman hazır

  factory CloudService() {
    return _instance;
  }

  CloudService._internal();

  static CloudService get instance => _instance;

  Future<void> ensureInitialized() async {
    // API tabanlı geçişte bağlantı yönetimi backend'e geçti
    return;
  }

  // Fallback images are now handled by the UI or Stock API only if DB is empty
  // Removing hardcoded Unsplash URLs from service layer

  /// Gastro resim URL'sini R2'ye dönüştür.
  /// Eski gastronomixsprod URL'lerini veya eksik URL'leri,
  /// tarif başlığından oluşturulan R2 URL'sine çevirir.
  static String _buildGastroR2ImageUrl(String title) {
    if (title.isEmpty) return '';
    const String cdnBaseUrl = 'https://yemek-resimler.aykutakcay85.workers.dev';
    // Sanitize: lowercase, remove special chars except spaces, replace spaces with _
    final sanitized = title
        .toLowerCase()
        .replaceAll(RegExp(r'[àáâãäå]'), 'a')
        .replaceAll(RegExp(r'[èéêë]'), 'e')
        .replaceAll(RegExp(r'[ìíîï]'), 'i')
        .replaceAll(RegExp(r'[òóôõö]'), 'o')
        .replaceAll(RegExp(r'[ùúûü]'), 'u')
        .replaceAll(RegExp(r'[ýÿ]'), 'y')
        .replaceAll('ç', 'c')
        .replaceAll('ñ', 'n')
        .replaceAll('ğ', 'g')
        .replaceAll('ı', 'i')
        .replaceAll('ş', 's')
        .replaceAll('-', ' ')                    // tire → boşluk (sonra _ olacak)
        .replaceAll(RegExp(r"[^a-z0-9\s]"), '') // remove non-alphanumeric except space
        .replaceAll(RegExp(r'\s+'), '_')         // spaces → underscore
        .replaceAll(RegExp(r'_+'), '_')           // collapse multiple underscores
        .replaceAll(RegExp(r'^_|_$'), '');         // trim leading/trailing underscores
    if (sanitized.isEmpty) return '';
    return '$cdnBaseUrl/gastro_images/$sanitized.webp?v=3';
  }

  /// Kayıttaki resim URL'sini Backend proxy'sine yönlendir.
  static String _resolveImageUrl(String? currentUrl, String title, String category) {
    if (currentUrl != null && currentUrl.isNotEmpty && currentUrl != 'null') {
      // Normalize: strip any existing ?v= query param
      final baseUrl = currentUrl.split('?v=').first;
      const String proxyBaseUrl = "https://chef-aykut-backend.onrender.com";
      
      // Old bucket pub-088807... → proxy
      if (baseUrl.contains('pub-088807d92556487e97d1ec1df970bc86')) {
        final path = baseUrl.replaceAll(RegExp(r'https?://pub-088807d92556487e97d1ec1df970bc86\.r2\.dev'), '');
        return '$proxyBaseUrl$path?v=3';
      }
      // Old bucket pub-f31f36f3... → proxy
      if (baseUrl.contains('pub-f31f36f3d95441bf8e622e620b1cda67.r2.dev')) {
        final path = baseUrl.replaceAll(RegExp(r'https?://pub-f31f36f3d95441bf8e622e620b1cda67\.r2\.dev'), '');
        return '$proxyBaseUrl$path?v=3';
      }
      // Already workers.dev — keep CDN directly
      if (baseUrl.contains('yemek-resimler.aykutakcay85.workers.dev')) {
        return '$baseUrl?v=3';
      }
      // Relative filename only (e.g. "pear_ice_cream.webp")
      if (baseUrl.isNotEmpty && !baseUrl.startsWith('http') && !baseUrl.startsWith('assets/')) {
        if (category.toLowerCase().contains('gastro')) {
          return 'https://yemek-resimler.aykutakcay85.workers.dev/gastro_images/$baseUrl?v=3';
        } else {
          return '$proxyBaseUrl/images/$baseUrl?v=3';
        }
      }
      // Other valid http URL — return as-is
      if (baseUrl.startsWith('http')) return '$baseUrl?v=3';
    }
    
    // Fallback: build from title for gastro
    if (category.toLowerCase().contains('gastro')) {
      return _buildGastroR2ImageUrl(title);
    }
    return '';
  }

  static String _resolveGastroImageUrl(String? currentUrl, String title) {
    return _resolveImageUrl(currentUrl, title, 'gastro');
  }



  Map<String, dynamic> _mapMongoDoc(Map<String, dynamic> doc) {
    // Case-insensitive key lookup helper
    dynamic getVal(List<String> keys) {
      for (var k in keys) {
        // Try exact match
        if (doc.containsKey(k)) return doc[k];
        // Try lowercase match
        final lowerK = k.toLowerCase();
        final foundKey = doc.keys.firstWhere(
          (key) => key.toLowerCase() == lowerK, 
          orElse: () => ""
        );
        if (foundKey.isNotEmpty) return doc[foundKey];
      }
      return null;
    }

    final idStr = getVal(['i', 'id', 'uid', '_id'])?.toString() ?? '';
    
    // Determine image URL — DB fields take absolute priority over stock fallbacks
    String imgUrl = '';
    
    // Explicitly check 'p' first but ONLY if it's a URL
    final pVal = getVal(['p'])?.toString() ?? '';
    if (pVal.startsWith('http')) {
      imgUrl = pVal;
    } else {
      for (final key in ['image_url', 'imageUrl', 'image', 'img', 'resim',
                          'photo', 'pic', 'thumbnail', 'recipe_image', 'resim_url', 'gorsel', 'photo_url']) {
        final val = getVal([key])?.toString() ?? '';
        if (val.isNotEmpty && val != 'null') {
          imgUrl = val;
          break;
        }
      }
    }

    // NEW: R2 Fallback - If still empty, construct R2 URL using ID
    final catStr = getVal(['c', 'category', 'main_category', 'cat'])?.toString() ?? '';
    if (imgUrl.isEmpty && idStr.isNotEmpty) {
      if (!catStr.toLowerCase().contains('gastro')) {
        const String r2BaseUrl = "https://pub-f31f36f3d95441bf8e622e620b1cda67.r2.dev";
        // We try .webp first as it's the standard for our R2 storage
        imgUrl = "$r2BaseUrl/images/$idStr.webp";
      }
    }

    // Ingredients mapping: Support 'm' (from chunks) and 'ingredients'
    dynamic rawIng = getVal([
      'm', 'ingredients', 'malzemeler', 'icindekiler', 'ingredientLines', 
      'recipeIngredient', 'ingredientsList', 'ing', 'materials', 'recipe_ingredients',
      'malzeme_listesi', 'icerik', 'components'
    ]);
    if (rawIng is String && rawIng.isNotEmpty && rawIng.startsWith('[')) {
      try { rawIng = json.decode(rawIng); } catch (_) {}
    }
    
    // Preparation steps mapping: Support 'y' (from chunks) and 'steps'
    dynamic rawSteps = getVal([
      'y', 'steps', 'directions', 'instructions', 'yapilis', 'hazirlanis', 
      'hazirlanisi', 'yapilisi', 'instructionLines', 'recipeInstructions', 
      'method', 'prep', 'preparation', 'recipe_steps', 'tarif', 'nasıl_yapılır', 'cooking_steps'
    ]);
    if (rawSteps is String && rawSteps.isNotEmpty && rawSteps.startsWith('[')) {
      try { rawSteps = json.decode(rawSteps); } catch (_) {}
    }

    final rawRating = getVal(['r', 'rating']);
    double rating = 0.0;
    if (rawRating != null) {
      if (rawRating is num) {
        rating = rawRating.toDouble();
      } else if (rawRating is String) {
        rating = double.tryParse(rawRating) ?? 0.0;
      }
    }

    final mapped = {
      'uid': idStr,
      'url': idStr,
      'name': getVal(['t', 'n', 'name', 'title', 'recipeName'])?.toString() ?? '',
      'title': getVal(['t', 'n', 'name', 'title', 'recipeName'])?.toString() ?? '',
      'main_category': getVal(['c', 'category', 'main_category', 'cat'])?.toString() ?? '',
      'category': getVal(['c', 'category', 'main_category', 'cat'])?.toString() ?? '',
      'sub_category': getVal(['subcategory', 'sub_category', 'sc'])?.toString() ?? '',
      'subcategory': getVal(['subcategory', 'sub_category', 'sc'])?.toString() ?? '',
      'rating': rating,
      'p': imgUrl,
      'o': int.tryParse(getVal(['o'])?.toString() ?? ''), // Offset
      'l': int.tryParse(getVal(['l'])?.toString() ?? ''), // Length
      'image_url': imgUrl,
      'image': imgUrl,
      'prep_time': getVal(['l', 'prep_time', 'total_time', 'pt', 'prepTime', 'time'])?.toString() ?? '',
      'cook_time': getVal(['cook_time', 'ct', 'cookTime', 'cook_minutes'])?.toString() ?? '',
      'nb_servings': getVal(['g', 'nb_servings', 'servings', 'ns', 'yield', 'nbServings', 'serves', 'kisi', 'porsiyon', 'servis', 'kac_kisilik', 'kisi_sayisi'])?.toString() ?? '',
      'chunk': getVal(['h', 'chunk'])?.toString(),
      'description': getVal(['d', 'description', 'desc'])?.toString(),
      'isPremium': getVal(['isPremium', 'premium']) == true || getVal(['isPremium', 'premium']) == 'true',
      'technique': getVal(['s', 'cooking_method', 'method'])?.toString(),
    };

    if (rawIng != null) {
      if (rawIng is List) {
        mapped['ingredients'] = rawIng;
      } else {
        mapped['ingredients'] = [rawIng.toString()];
      }
    } else {
      mapped['ingredients'] = <String>[];
    }

    if (rawSteps != null) {
      if (rawSteps is List) {
        mapped['steps'] = rawSteps;
      } else {
        mapped['steps'] = [rawSteps.toString()];
      }
    } else {
      mapped['steps'] = <String>[];
    }
    
    // Shorthand keys for compatibility with Model.fromJson
    mapped['m'] = mapped['ingredients'];
    mapped['y'] = mapped['steps'];
    mapped['i'] = idStr;
    mapped['t'] = mapped['name'];
    mapped['g'] = mapped['nb_servings'];

    // 🖼️ Tüm tariflerin resimlerini R2/Workers yerine Render proxy adresine yönlendir
    final resolvedImg = _resolveImageUrl(
      mapped['image_url']?.toString(),
      mapped['name']?.toString() ?? '',
      mapped['category']?.toString() ?? '',
    );
    if (resolvedImg.isNotEmpty) {
      mapped['p'] = resolvedImg;
      mapped['image_url'] = resolvedImg;
      mapped['image'] = resolvedImg;
    }

    print("🔍 DEBUG: _mapMongoDoc Result: ingredients=${(mapped['ingredients'] as List).length}, steps=${(mapped['steps'] as List).length}");
    if ((mapped['ingredients'] as List).isEmpty) {
       print("⚠️ DEBUG: ingredients list is empty for $idStr. rawIng was: $rawIng");
    }

    return mapped;
  }

  Future<int> getTotalRecipeCount() async {
    try {
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/recipes/count"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));
      if (response.statusCode == 200) {
        return json.decode(response.body)['count'] ?? 0;
      }
    } catch (e) {
      print("❌ CloudService API Error (Count): $e");
    }
    return 0;
  }

  Future<Map<String, int>> getCategoryCounts() async {
    try {
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/recipes/counts"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));
      if (response.statusCode == 200) {
        final Map<String, dynamic> data = json.decode(response.body);
        return data.map((key, value) => MapEntry(key, int.tryParse(value.toString()) ?? 0));
      }
    } catch (e) {
      print("❌ CloudService API Error (Counts): $e");
    }
    return {};
  }

  Future<List<String>> getSubCategories(String category) async {
    try {
      final encodedCategory = Uri.encodeComponent(category);
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/recipes/categories/$encodedCategory/subs"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        return data.map((e) => e.toString()).toList();
      }
    } catch (e) {
      print("❌ CloudService API Error (Subs): $e");
    }
    return [];
  }

  Future<List<Map<String, dynamic>>> getRecipesByCategory(String category, {String? subcategory, int limit = 20, int offset = 0, int page = 0}) async {

    try {
      final actualPage = page > 0 ? page : (offset ~/ limit) + 1;
      final encodedCategory = Uri.encodeComponent(category);
      String url = "$_apiBaseUrl/recipes?category=$encodedCategory&page=$actualPage&limit=$limit";
      if (subcategory != null && subcategory.isNotEmpty) {
        url += "&subcategory=${Uri.encodeComponent(subcategory)}";
      }
      
      final response = await http.get(
        Uri.parse(url),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        
        // Safety Fallback: If direct category query returns empty (e.g. singular/plural mismatch),
        // try a search for the category name as a fallback.
        if (data.isEmpty && offset == 0 && !category.contains(' ')) {
           print("⚠️ Category query for '$category' returned empty. Trying search fallback...");
           return await searchRecipesAdvanced(category, offset: 0, limit: limit);
        }
        
        return data.map<Map<String, dynamic>>((d) => _mapMongoDoc(d as Map<String, dynamic>)).toList();
      }
    } catch (e) {
      print("❌ CloudService API Error (Category): $e");
    }
    return [];
  }

  Future<Map<String, Map<String, dynamic>>> getHomePreviews() async {
    try {
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/home/previews"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final Map<String, dynamic> data = json.decode(response.body);
        final Map<String, Map<String, dynamic>> results = {};
        
        data.forEach((key, value) {
          results[key] = Map<String, dynamic>.from(value);
        });
        
        return results;
      }
    } catch (e) {
      print("❌ CloudService API Error (Home Previews): $e");
    }
    return {};
  }

  Future<List<Map<String, dynamic>>> getDailyRecipes() async {
    try {
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/daily"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        return data.map<Map<String, dynamic>>((d) => _mapMongoDoc(d as Map<String, dynamic>)).toList();
      }
    } catch (e) {
      print("❌ CloudService API Error (Daily): $e");
    }
    return [];
  }

  Future<Map<String, dynamic>?> getRecipeByUid(String uid, {String? title}) async {
    try {
      final encodedUid = Uri.encodeComponent(uid);
      final requestUrl = "$_apiBaseUrl/recipes/$encodedUid";
      print("🔍 DEBUG: Fetching Detail from: $requestUrl");
      
      final response = await http.get(
        Uri.parse(requestUrl),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final Map<String, dynamic> data = json.decode(response.body);
        final mapped = _mapMongoDoc(data);
        
        // R2 Fallback if content is empty
        if ((mapped['ingredients'] as List).isEmpty && mapped['chunk'] != null) {
           print("🔄 Content empty for $uid, trying R2 fallback (Chunk: ${mapped['chunk']})");
           final r2Data = await getRecipeDetailsFromR2(mapped['chunk'], uid, title: title ?? mapped['title']);
           if (r2Data != null) {
             return { ...mapped, ...r2Data };
           }
        }
        return mapped;
      }
    } catch (e) {
      print("❌ CloudService API Error (Detail): $e");
    }
    return null;
  }

  String _normalizeTitle(String? str) {
    if (str == null) return "";
    return str.toLowerCase()
        .replaceAll('Ã¨', 'e')
        .replaceAll('Ã©', 'e')
        .replaceAll('Ã¢', 'a')
        .replaceAll('Ã¯', 'i')
        .replaceAll('Ã§', 'c')
        .replaceAll('Ã¨', 'e')
        .replaceAll('è', 'e')
        .replaceAll('é', 'e')
        .replaceAll('ê', 'e')
        .replaceAll('ë', 'e')
        .replaceAll('à', 'a')
        .replaceAll('â', 'a')
        .replaceAll('ä', 'a')
        .replaceAll('î', 'i')
        .replaceAll('ï', 'i')
        .replaceAll('ô', 'o')
        .replaceAll('ö', 'o')
        .replaceAll('û', 'u')
        .replaceAll('ü', 'u')
        .replaceAll('ç', 'c')
        .replaceAll('ğ', 'g')
        .replaceAll('ı', 'i')
        .replaceAll('ö', 'o')
        .replaceAll('ş', 's')
        .replaceAll('ü', 'u')
        .replaceAll(RegExp(r'[^a-z0-9]'), '')
        .trim();
  }

  Future<Map<String, dynamic>?> getRecipeDetailsFromR2(dynamic chunkId, String recipeId, {String? title}) async {
    try {
      const String r2BaseUrl = "https://pub-f31f36f3d95441bf8e622e620b1cda67.r2.dev";
      
      final List<String> urls = [
        "$r2BaseUrl/foodi/chunk_$chunkId.json",
        "$r2BaseUrl/chunks/chunk_$chunkId.json",
        "$r2BaseUrl/chunk_$chunkId.json"
      ];

      for (final url in urls) {
        try {
          final response = await http.get(Uri.parse(url)).timeout(const Duration(seconds: 30));
          if (response.statusCode == 200) {
            final String data = response.body;
            List<dynamic> chunkData;
            try {
              final parsed = json.decode(data);
              chunkData = parsed is List ? parsed : [parsed];
            } catch (_) {
              try {
                chunkData = data.trim().split('\n').map((line) => json.decode(line)).toList();
              } catch (e) { continue; }
            }

            final detail = chunkData.firstWhere(
              (r) => r['i'] == recipeId || r['id'] == recipeId || r['uid'] == recipeId || r['url'] == recipeId ||
                     (title != null && (_normalizeTitle(r['t']?.toString()) == _normalizeTitle(title) || 
                                        _normalizeTitle(r['title']?.toString()) == _normalizeTitle(title))), 
              orElse: () => null
            );
            if (detail != null) return _mapMongoDoc(detail as Map<String, dynamic>);
          }
        } catch (_) {}
      }

      // 🔒 SECURE MINIO FALLBACK
      try {
        print("🔒 R2 HTTP Failed or timed out. Attempting secure Minio connection for chunk $chunkId...");
        final minio = Minio(
          endPoint: 'c1cd8dfae75fe4b50ae174f260fd5a43.r2.cloudflarestorage.com',
          accessKey: 'a834c46f9493451741157b87ab21426d',
          secretKey: '9b734ce673ce4471fe7be01c0cae8f2a1d7c772e09295d1ed228c4fa1a05e7bf',
          region: 'auto',
          useSSL: true,
        );
        final stream = await minio.getObject('foodi', 'chunk_$chunkId.json');
        final bytes = <int>[];
        await for (var chunk in stream) {
          bytes.addAll(chunk);
        }
        final String data = utf8.decode(bytes);
        List<dynamic> chunkData;
        try {
          final parsed = json.decode(data);
          chunkData = parsed is List ? parsed : [parsed];
        } catch (_) {
          chunkData = data.trim().split('\n').map((line) => json.decode(line)).toList();
        }
        final detail = chunkData.firstWhere(
          (r) => r['i'] == recipeId || r['id'] == recipeId || r['uid'] == recipeId || r['url'] == recipeId ||
                 (title != null && (_normalizeTitle(r['t']?.toString()) == _normalizeTitle(title) || 
                                    _normalizeTitle(r['title']?.toString()) == _normalizeTitle(title))), 
          orElse: () => null
        );
        if (detail != null) {
          print("✅ Secure Minio Fetch Successful!");
          return _mapMongoDoc(detail as Map<String, dynamic>);
        }
      } catch (e) {
        print("❌ Secure Minio Fetch Error: $e");
      }
      
      // 🔄 Fallback to Chef/Gastro if not already searching them
      if (chunkId.toString() != 'chef' && chunkId.toString() != 'gastro') {
        print("🔍 R2 Fallback: Trying 'chef' chunk...");
        final chefData = await getRecipeDetailsFromR2('chef', recipeId, title: title);
        if (chefData != null) return chefData;
        
        print("🔍 R2 Fallback: Trying 'gastro' chunk...");
        return await getRecipeDetailsFromR2('gastro', recipeId, title: title);
      }
    } catch (e) {
      print("❌ R2 Fetch Error: $e");
    }
    return null;
  }

  // ✅ Cloudflare R2'den Gastro tarif listesini güvenli Minio/S3 ile çeken verimli metot
  Future<List<Map<String, dynamic>>> getGastroRecipesFromR2({int offset = 0, int limit = 20}) async {
    try {
      print("☁️ R2 S3: Fetching Gastro Recipes (offset: $offset, limit: $limit)...");
      
      final minio = Minio(
        endPoint: 'c1cd8dfae75fe4b50ae174f260fd5a43.r2.cloudflarestorage.com',
        accessKey: '5ea1939cd95a7d493717e44f5f888e44',
        secretKey: 'cbf217f65b0c28d122a592d9b46d4c967e0a5de67fad65d5d3f95e80a9426d56',
        region: 'auto',
        useSSL: true,
      );

      final int startChunkIndex = offset ~/ 1000;
      final int endChunkIndex = (offset + limit) ~/ 1000;
      final List<Map<String, dynamic>> combinedResults = [];
      
      for (int i = startChunkIndex; i <= endChunkIndex; i++) {
        if (i > 5) break; // En fazla 6 chunk var (0-5)
        
        final chunkKey = 'gastro_chunk_$i.json';
        try {
          final stream = await minio.getObject('foodi', chunkKey);
          final bytes = <int>[];
          await for (var chunk in stream) {
            bytes.addAll(chunk);
          }
          
          final String data = utf8.decode(bytes);
          final List<dynamic> chunkList = json.decode(data);
          
          final int chunkStartOffset = i * 1000;
          final int localStart = (offset - chunkStartOffset).clamp(0, chunkList.length);
          final int localEnd = (offset + limit - chunkStartOffset).clamp(0, chunkList.length);
          
          if (localStart < localEnd) {
            final subList = chunkList.sublist(localStart, localEnd);
            
            // Tarif resim URL'lerini kendi R2 adresimize göre eşleştirelim
            for (var item in subList) {
              final map = Map<String, dynamic>.from(item);
              
              // 🖼️ Gastro resim URL'sini R2'ye dönüştür
              final title = (map['t'] ?? map['title'] ?? map['recipe_name'] ?? '').toString();
              final currentImg = (map['p'] ?? map['image'] ?? map['image_url'] ?? '').toString();
              final r2Img = _resolveGastroImageUrl(currentImg, title);
              if (r2Img.isNotEmpty) {
                map['p'] = r2Img;
                map['image'] = r2Img;
                map['image_url'] = r2Img;
              }
              
              combinedResults.add(_mapMongoDoc(map));
            }
          }
        } catch (e) {
          print("⚠️ R2 Gastro S3 Chunk $i load error: $e");
        }
      }
      
      print("✅ R2 S3: Gastro list size returning: ${combinedResults.length}");
      return combinedResults;
    } catch (e) {
      print("❌ R2 S3 Gastro list error: $e");
    }
    return [];
  }

  // Arama vb. diğer metodlar da benzer şekilde API'ye yönlendirilmeli...
  Future<List<Map<String, dynamic>>> getRecipesBySubCategory(String category, String subcategory, {int offset = 0, int limit = 20}) async {
    try {
      final page = offset ~/ limit;
      final encodedCategory = Uri.encodeComponent(category);
      final encodedSubCategory = Uri.encodeComponent(subcategory);
      final url = "$_apiBaseUrl/recipes?category=$encodedCategory&subcategory=$encodedSubCategory&page=$page&limit=$limit";
      print("🔍 DEBUG: Fetching SubCategory Recipes from: $url");
      final response = await http.get(
        Uri.parse(url),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        return data.map<Map<String, dynamic>>((d) => _mapMongoDoc(d as Map<String, dynamic>)).toList();
      }
    } catch (e) {
      print("❌ CloudService API Error (SubCategory Recipes): $e");
    }
    return [];
  }

  Future<List<Map<String, dynamic>>> fetchRecipeDetails(List<Map<String, dynamic>> recipes) async {
    return recipes;
  }

  Future<List<Map<String, dynamic>>> searchRecipesAdvanced(String query, {int offset = 0, int limit = 20}) async {
    try {
      final page = (offset / limit).floor();
      final encodedQuery = Uri.encodeComponent(query);
      final response = await http.get(
        Uri.parse("$_apiBaseUrl/recipes?q=$encodedQuery&page=$page&limit=$limit"),
        headers: _headers,
      ).timeout(const Duration(seconds: 60));

      if (response.statusCode == 200) {
        final List<dynamic> data = json.decode(response.body);
        return data.map<Map<String, dynamic>>((d) => _mapMongoDoc(d as Map<String, dynamic>)).toList();
      }
    } catch (e) {
      print("❌ CloudService API Error (Search): $e");
    }
    return [];
  }

  Future<void> updateRecipeImage(String uid, String imageUrl) async {
    try {
      final response = await http.patch(
        Uri.parse("$_apiBaseUrl/recipes/${Uri.encodeComponent(uid)}/image"),
        headers: _headers,
        body: json.encode({"image": imageUrl}),
      ).timeout(const Duration(seconds: 15));
      
      if (response.statusCode == 200) {
        print("✅ CloudService: Recipe image updated successfully in DB");
      }
    } catch (e) {
      print("❌ CloudService Error (Update Image): $e");
    }
  }
}
