import 'dart:convert';

class Recipe {
  String name;
  String url;
  String? imageUrl;
  String? category;
  String? cuisine;
  String? subcategory;
  String? difficulty;
  String? dietType;
  String? mainIngredient;
  String? cookingMethod;
  String? mealType;
  String? spiceLevel;
  String? region;
  String? prepTime;
  String? cookTime;
  String? totalTime;
  String? nbServings;
  String? tips;
  String? cooksNote;
  int? chunk;
  
  List<String> ingredients;
  List<String> steps;
  
  List<Instruction>? instructions;
  
  Nutrition? nutrition;
  
  double? rating;

  Recipe({
    required this.name,
    required this.url,
    this.imageUrl,
    this.category,
    this.cuisine,
    this.subcategory,
    this.difficulty,
    this.dietType,
    this.mainIngredient,
    this.cookingMethod,
    this.mealType,
    this.spiceLevel,
    this.region,
    this.prepTime,
    this.cookTime,
    this.totalTime,
    this.nbServings,
    this.tips,
    this.cooksNote,
    this.chunk,
    this.ingredients = const [],
    this.steps = const [],
    this.instructions,
    this.nutrition,
    this.rating,
    this.alternativeTitle,
  });

  String? alternativeTitle;

  factory Recipe.fromJson(Map<String, dynamic> json) {
    // Helper to clean ingredient strings (fix missing spaces in Turkish recipes)
    String _cleanIngredient(String raw) {
      var s = raw;
      // 1. Add space between digit and letter (e.g., "4adet" -> "4 adet")
      // Also handles fractions like "1/2su" -> "1/2 su" because '2' is a digit
      s = s.replaceAllMapped(
        RegExp(r'(\d)([a-zA-ZçÇğĞıİöÖşŞüÜ])'),
        (match) => '${match.group(1)} ${match.group(2)}'
      );
      
      // 2. Add space after known units if stuck to next word (e.g., "adetbüyük" -> "adet büyük")
      // Units: adet, demet, paket, diş, gram, kg, litre, ml, kase, dilim, bardağı, kaşığı, fincanı
      final units = [
        'adet', 'demet', 'paket', 'diş', 'gram', 'kg', 'litre', 'ml', 'kase', 'dilim', 
        'bardağı', 'kaşığı', 'fincanı'
      ];
      final unitsPattern = units.join('|');
      s = s.replaceAllMapped(
        RegExp('($unitsPattern)([a-zA-ZçÇğĞıİöÖşŞüÜ])'),
        (match) => '${match.group(1)} ${match.group(2)}'
      );
      
      return s;
    }

    // Helper to safely read first non-empty value from multiple keys
    String? _firstString(List<String> keys) {
      for (final k in keys) {
        final v = json[k];
        if (v == null) continue;
        final s = v.toString();
        if (s.trim().isNotEmpty) return s;
      }
      return null;
    }

    // Helper to parse minutes from strings like "8 minutes", "1 hour", "45 min"
    int _parseMinutes(String? timeStr) {
      if (timeStr == null || timeStr.trim().isEmpty) return 0;
      final regex = RegExp(r"(\d+)\s*(hour|hours|hr|h|minute|minutes|min|m)", caseSensitive: false);
      final matches = regex.allMatches(timeStr);
      var total = 0;
      for (final m in matches) {
        final value = int.tryParse(m.group(1) ?? '0') ?? 0;
        final unit = (m.group(2) ?? '').toLowerCase();
        if (unit.contains('hour') || unit == 'hr' || unit == 'h') {
          total += value * 60;
        } else {
          total += value;
        }
      }
      return total;
    }
    // Handle ingredients - can be List or String
    List<String> ingredientsList = [];
    try {
      // Use short key 'm' as primary, with fallbacks
      var rawIngredients = json['m'] ?? json['ingredients'] ?? json['malzemeler'] ?? json['ingredientLines'] ?? json['i'];

      if (rawIngredients != null) {
        if (rawIngredients is List) {
          ingredientsList = rawIngredients
              .where((item) => item != null && item.toString().trim().isNotEmpty)
              .map<String>((item) => _cleanIngredient(item.toString().trim()))
              .toList();
        } else if (rawIngredients is String) {
          final ingredientsStr = rawIngredients.trim();
          if (ingredientsStr.isNotEmpty) {
            // STEP 1: Attempt JSON Decode if it looks like a list
            if (ingredientsStr.startsWith('[') && ingredientsStr.endsWith(']')) {
              try {
                final decoded = jsonDecode(ingredientsStr);
                if (decoded is List) {
                  ingredientsList = decoded
                      .where((s) => s != null && s.toString().trim().isNotEmpty)
                      .map((s) => _cleanIngredient(s.toString().trim()))
                      .toList()
                      .cast<String>();
                }
              } catch (e) {
                // Not valid JSON, will try manual fallback below
              }
            }
            
            // STEP 2: Manual fallback for JSON-like strings that failed to decode
            if (ingredientsList.isEmpty && (ingredientsStr.startsWith('[') || ingredientsStr.contains('", "'))) {
              var cleaned = ingredientsStr
                  .replaceAll(RegExp(r'^\[|\]$'), '')
                  .replaceAll(RegExp(r'^"|"$'), '')
                  .split('", "');
              
              if (cleaned.length <= 1) cleaned = ingredientsStr.split('","');
              if (cleaned.length <= 1) cleaned = ingredientsStr.split("', '");
              
              if (cleaned.length > 1) {
                for (var s in cleaned) {
                  String item = s.toString();
                  if (item.startsWith('"') || item.startsWith("'")) {
                    item = item.substring(1);
                  }
                  if (item.endsWith('"') || item.endsWith("'")) {
                    item = item.substring(0, item.length - 1);
                  }
                  item = item.trim();
                  if (item.isNotEmpty) {
                    ingredientsList.add(_cleanIngredient(item));
                  }
                }
              }
            }

            // STEP 3: Fallback for common delimiters
            if (ingredientsList.isEmpty) {
              const delimiters = ['\n', ' | ', ' ; ', '; ', ' • ', ' - '];
              for (var delim in delimiters) {
                if (ingredientsStr.contains(delim)) {
                  ingredientsList = ingredientsStr.split(delim)
                      .where((s) => s.trim().isNotEmpty && s.trim().length > 2)
                      .map((s) => _cleanIngredient(s.trim().replaceAll(RegExp(r'^[-•*]\s*'), '')))
                      .toList()
                      .cast<String>();
                  if (ingredientsList.length > 1) break;
                }
              }
            }

            // STEP 4: If still empty and contains commas, split by comma
            if (ingredientsList.isEmpty && ingredientsStr.contains(',')) {
               ingredientsList = ingredientsStr.split(',')
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => _cleanIngredient(s.trim()))
                  .toList()
                  .cast<String>();
            }

            // STEP 5: Last resort - Regex for line starts
            if (ingredientsList.isEmpty) {
               final matches = RegExp(r'(?:^|\n)\s*([-•*\d]+)\.?\s*([^\n]+)').allMatches(ingredientsStr);
               if (matches.isNotEmpty) {
                 ingredientsList = matches
                     .map((m) => _cleanIngredient(m.group(2)?.trim() ?? ''))
                     .where((s) => s.isNotEmpty)
                     .toList();
               }
            }
            
            // Final fallback
            if (ingredientsList.isEmpty) {
              ingredientsList = [_cleanIngredient(ingredientsStr)];
            }
          }
        }
      }
    } catch (e) {
      print('⚠️ Error parsing ingredients: $e');
      ingredientsList = [];
    }

    // Handle steps - can be List or String
    List<String> stepsList = [];
    try {
      // Use short key 'y' as primary, with fallbacks
      dynamic stepsData = json['y'] ?? json['steps'] ?? json['directions'] ?? json['instructions'] ?? json['yapilis'] ?? json['hazirlanis'] ?? json['instructionLines'] ?? json['recipeInstructions'];

      if (stepsData != null) {
        if (stepsData is List) {
          final rawList = stepsData as List;
          stepsList = rawList
              .where((item) => item != null && item.toString().trim().isNotEmpty)
              .map<String>((item) => item.toString().trim())
              .toList();
        } else if (stepsData is String) {
          var stepsStr = stepsData as String;
          if (stepsStr.isNotEmpty) {
            // Try splitting by common delimiters
            List<String> splitSteps = [];
            
            // Check if it's a JSON array string (e.g., '["step1", "step2"]')
            if (stepsStr.trim().startsWith('[') && stepsStr.trim().endsWith(']')) {
              try {
                // Parse as JSON array
                final decoded = jsonDecode(stepsStr);
                if (decoded is List) {
                  splitSteps = decoded
                      .where((s) => s != null && s.toString().trim().isNotEmpty)
                      .map((s) => s.toString().trim())
                      .toList();
                }
              } catch (jsonError) {
                print('⚠️ JSON parse error for directions: $jsonError');
                // Fallback: remove brackets and quotes manually
                stepsStr = stepsStr
                    .replaceAll('[', '')
                    .replaceAll(']', '')
                    .replaceAll('"', '')
                    .replaceAll("'", '');
                // Split by comma first, then by period if needed
                splitSteps = stepsStr.split(',')
                    .expand((s) {
                      // If a comma-separated item has multiple sentences, split by period
                      if (s.contains('. ')) {
                        return s.split('. ')
                            .where((sentence) => sentence.trim().isNotEmpty)
                            .map((sentence) => sentence.trim());
                      }
                      return [s.trim()];
                    })
                    .where((s) => s.isNotEmpty)
                    .toList();
              }
            }
            // Try numbered steps (e.g., "1. Step one 2. Step two")
            else if (stepsStr.contains(RegExp(r'\d+\.\s'))) {
              splitSteps = stepsStr
                  .split(RegExp(r'\d+\.\s'))
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => s.trim())
                  .toList();
            }
            // Try pipe delimiter
            else if (stepsStr.contains(' | ')) {
              splitSteps = stepsStr.split(' | ')
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => s.trim())
                  .toList();
            }
            // Try newline delimiter
            else if (stepsStr.contains('\n')) {
              splitSteps = stepsStr.split('\n')
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => s.trim())
                  .toList();
            }
            // Try period + space delimiter (sentence endings)
            else if (stepsStr.contains('. ')) {
              splitSteps = stepsStr.split('. ')
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => s.trim())
                  .toList();
            }
            // Try comma delimiter (after removing quotes)
            else if (stepsStr.contains(',')) {
              // Remove quotes first
              stepsStr = stepsStr.replaceAll('"', '').replaceAll("'", '');
              splitSteps = stepsStr.split(',')
                  .where((s) => s.trim().isNotEmpty)
                  .map((s) => s.trim())
                  .toList();
            }
            // If no delimiter found, treat as single step
            else {
              splitSteps = [stepsStr.trim()];
            }
            
            stepsList = splitSteps;
          }
        }
      }
    } catch (e) {
      print('⚠️ Error parsing steps/directions: $e');
      stepsList = [];
    }

    // Handle nutrition - can be Map or String
    Nutrition? nutritionObj;
    final nutritionData = json['nutrition'] ?? json['nutritional_info'] ?? json['nutrients'];
    if (nutritionData != null) {
      if (nutritionData is Map) {
        nutritionObj = Nutrition.fromJson(Map<String, dynamic>.from(nutritionData));
      } else if (nutritionData is String && nutritionData.trim().isNotEmpty) {
         // Attempt to parse JSON string
         try {
            final decoded = jsonDecode(nutritionData);
            if (decoded is Map) {
               nutritionObj = Nutrition.fromJson(Map<String, dynamic>.from(decoded));
            }
         } catch(_) {}
      }
    }
    
    // Fallback: Check root level for calories if nutrition object is still empty/null
    if (nutritionObj == null || nutritionObj.calories == null) {
       final rootCalories = json['calories'] ?? json['kcal'] ?? json['energy'];
       if (rootCalories != null) {
          nutritionObj ??= Nutrition();
          nutritionObj.calories = rootCalories.toString();
       }
    }

    // Handle instructions - can be List of Maps or List of Strings
    List<Instruction>? instructionsList;
    try {
      if (json['instructions'] != null && json['instructions'] is List) {
        final rawList = json['instructions'] as List;
        instructionsList = rawList
            .map((item) {
              if (item is Map<String, dynamic>) {
                return Instruction.fromJson(Map<String, dynamic>.from(item));
              } else if (item is String) {
                return Instruction(text: item);
              }
              return null;
            })
            .where((item) => item != null)
            .cast<Instruction>()
            .toList();
      }
    } catch (e) {
      print('⚠️ Error parsing instructions: $e');
      instructionsList = null;
    }

    // Handle rating
    double? ratingValue;
    final rawRating = json['r'] ?? json['rating'];
    if (rawRating != null) {
      if (rawRating is num) {
        ratingValue = rawRating.toDouble();
      } else if (rawRating is String) {
        ratingValue = double.tryParse(rawRating);
      }
    }

    // Map time fields - support alternate keys used by chef.json and various formats
    var prepTimeStr = _firstString(['pt', 'prep_time', 'preparation_time', 'prep_minutes', 'prep_min']);
    var cookTimeStr = _firstString(['ct', 'cook_time', 'cooking_time', 'cook_minutes', 'cook_min']);
    var totalTimeStr = _firstString(['l', 'total_time', 'total_minutes', 'time']);
    if ((totalTimeStr == null || totalTimeStr.isEmpty) && (prepTimeStr != null || cookTimeStr != null)) {
      final totalMins = _parseMinutes(prepTimeStr) + _parseMinutes(cookTimeStr);
      if (totalMins > 0) {
        totalTimeStr = totalMins == 60
            ? '1 hour'
            : (totalMins % 60 == 0 ? '${(totalMins / 60).round()} hours' : '$totalMins minutes');
      }
    }

    // Fallback: Scan steps for time if still missing
    if (totalTimeStr == null || totalTimeStr.isEmpty) {
      int totalMinsFromSteps = 0;
      // Regex for "10 minutes", "1 hour", "30 min", "20 dk"
      final timeRegex = RegExp(r'(\d+)\s*(minute|min|m|hour|hr|h|saat|osa|dakika|dk)', caseSensitive: false);
      
      for (var step in stepsList) {
        final matches = timeRegex.allMatches(step);
        for (final m in matches) {
          int val = int.tryParse(m.group(1) ?? '0') ?? 0;
          String unit = (m.group(2) ?? '').toLowerCase();
          
          // Avoid unrealistic numbers (e.g. "heat oven to 350 degrees")
          if (val > 300 && !unit.startsWith('d')) continue; 
          
          if (unit.startsWith('h') || unit.startsWith('s') || unit == 'osa') {
             totalMinsFromSteps += val * 60;
          } else {
             totalMinsFromSteps += val;
          }
        }
      }
      
      // Reasonable cap (e.g. don't sum up every mentioned minute if it exceeds 5 hours unexpectedly)
      if (totalMinsFromSteps > 0 && totalMinsFromSteps < 600) {
         totalTimeStr = totalMinsFromSteps >= 60 
            ? '${(totalMinsFromSteps / 60).toStringAsFixed(0)} hr ${totalMinsFromSteps % 60} min'
            : '$totalMinsFromSteps min';
      } else {
         // Final default based on complexity
         totalTimeStr = (ingredientsList.length > 8) ? '45 min' : '25 min';
      }
    }

    // Fallback: If only Total Time is available, distribute it or assign to cook time
    if ((prepTimeStr == null && cookTimeStr == null) && totalTimeStr != null) {
       // Parse minutes to be safer
       int totalMin = _parseMinutes(totalTimeStr);
       if (totalMin > 0) {
          if (totalMin > 20) {
              prepTimeStr = "15 min";
              cookTimeStr = "${totalMin - 15} min";
          } else {
              prepTimeStr = "5 min";
              cookTimeStr = "${totalMin > 5 ? totalMin - 5 : 0} min";
          }
       } else {
          // If string parse failed but text exists
          cookTimeStr = totalTimeStr; 
          prepTimeStr = "N/A";
       }
    }

    // Porsiyon bilgisini çekmek için tüm olası anahtarları (keys) kontrol edelim
    var servingsStr = (json['g'] ?? json['nb_servings'] ?? json['servings'] ?? json['n'] ?? json['ns'] ?? json['yield'] ?? json['serves'])?.toString();
    
    if (servingsStr == null || servingsStr.isEmpty || servingsStr == 'null') {
       // AKILLI TAHMİN: Malzeme sayısı ve süreye göre porsiyon belirle
       int ingredientCount = ingredientsList.length;
       if (ingredientCount >= 15) {
         servingsStr = '8-10 Kişilik';
       } else if (ingredientCount >= 10) {
         servingsStr = '6-8 Kişilik';
       } else if (ingredientCount >= 5) {
         servingsStr = '4-6 Kişilik';
       } else if (ingredientCount > 0) {
         servingsStr = '2-4 Kişilik';
       } else {
         // Liste görünümü için (henüz malzemeler yüklenmediyse) varsayılan
         servingsStr = '4-6 Kişilik';
       }
    }


    // Optimize Image Path for WebP (Local Assets Only)
    String? rawImg = json['p'] ?? json['image_url'] ?? json['image'];
    String? finalImg = rawImg;
    if (rawImg != null && rawImg.toString().startsWith('assets/') && 
       (rawImg.toString().toLowerCase().endsWith('.jpg') || rawImg.toString().toLowerCase().endsWith('.png'))) {
       finalImg = rawImg.toString().replaceAll(RegExp(r'\.(jpg|png|JPG|PNG)$'), '.webp');
    }

    return Recipe(
      name: json['t'] ?? json['name'] ?? json['title'] ?? '',
      url: json['i'] ?? json['url'] ?? json['uid'] ?? json['link'] ?? '',
      alternativeTitle: (json['t'] != null && json['title'] != null && json['t'] != json['title']) ? json['title'] : null,
      imageUrl: finalImg,
      category: (json['c'] ?? json['category'] ?? json['main_category'])?.toString(),
      cuisine: json['cuisine']?.toString(),
      subcategory: (json['s'] ?? json['subcategory'] ?? json['sub_category'])?.toString(),
      difficulty: json['difficulty']?.toString(),
      dietType: json['diet_type']?.toString(),
      mainIngredient: json['main_ingredient']?.toString(),
      cookingMethod: json['cooking_method']?.toString(),
      mealType: json['meal_type']?.toString(),
      spiceLevel: json['spice_level']?.toString(),
      region: json['region']?.toString(),
      prepTime: prepTimeStr,
      cookTime: cookTimeStr,
      totalTime: totalTimeStr,
      nbServings: servingsStr,
      tips: json['tips']?.toString(),
      cooksNote: json['cooks_note']?.toString(),
      chunk: json['h'] != null ? int.tryParse(json['h'].toString()) : (json['chunk'] != null ? int.tryParse(json['chunk'].toString()) : null),
      ingredients: ingredientsList,
      steps: stepsList,
      instructions: instructionsList,
      nutrition: nutritionObj,
      rating: ratingValue,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'i': url,
      't': name,
      'p': imageUrl,
      'c': category,
      's': subcategory,
      'pt': prepTime,
      'ct': cookTime,
      'l': totalTime,
      'g': nbServings,
      'h': chunk,
      'm': ingredients,
      'y': steps,
      'r': rating,
      'instructions': instructions?.map((i) => {
        'text': i.text,
        'video_url': i.videoUrl,
        'image_url': i.imageUrl,
        'start_time': i.startTime,
        'end_time': i.endTime,
      }).toList(),
      'nutrition': nutrition?.toJson(),
      // Legacy support in JSON for any older dependencies
      'name': name,
      'url': url,
      'image_url': imageUrl,
      'category': category,
    };
  }

  // Helper method to resolve nutrition as a map
  Map<String, dynamic>? _nutritionToJson() {
    if (nutrition == null) return null;
    return {
      'calories': nutrition?.calories,
      'carbohydrateContent': nutrition?.carbohydrateContent,
      'cholesterolContent': nutrition?.cholesterolContent,
      'fiberContent': nutrition?.fiberContent,
      'proteinContent': nutrition?.proteinContent,
      'saturatedFatContent': nutrition?.saturatedFatContent,
      'sodiumContent': nutrition?.sodiumContent,
      'sugarContent': nutrition?.sugarContent,
      'fatContent': nutrition?.fatContent,
      'unsaturatedFatContent': nutrition?.unsaturatedFatContent,
    };
  }

  // Helper method to get ingredients as string (for backward compatibility)
  String get ingredientsString => ingredients.join(' | ');

  // Helper method to get steps as string (for backward compatibility)
  String get stepsString => steps.join(' | ');

  // Helper method to get nutrition as string (for backward compatibility)
  String get nutritionString {
    final n = nutrition;
    if (n == null) return '';
    final parts = <String>[];
    if (n.calories != null) parts.add('Calories: ${n.calories}');
    if (n.proteinContent != null) parts.add('Protein: ${n.proteinContent}');
    if (n.fatContent != null) parts.add('Fat: ${n.fatContent}');
    if (n.carbohydrateContent != null) parts.add('Carbs: ${n.carbohydrateContent}');
    return parts.join(', ');
  }

  // Helper method to get servings as int
  int? get servings {
    if (nbServings == null || nbServings!.isEmpty || nbServings == 'null') return null;
    
    // 1. Basit sayı parse (örn: "4")
    final val = int.tryParse(nbServings!.trim());
    if (val != null && val > 0) return val;
    
    // 2. Aralık ve metin içinden sayıları çıkar (örn: "4-6 kişilik", "12 adet")
    final matches = RegExp(r'(\d+)').allMatches(nbServings!);
    if (matches.isNotEmpty) {
       final values = matches
           .map((m) => int.tryParse(m.group(0)!) ?? 0)
           .where((v) => v > 0)
           .toList();
           
       if (values.length >= 2) {
         // Aralık varsa ortalamasını al (örn: 4-6 -> 5)
         return (values[0] + values[1]) ~/ 2;
       } else if (values.isNotEmpty) {
         return values[0];
       }
    }
    return null;
  }
  
  // Helper method to get effective image URL
  // Returns the existing imageUrl or a placeholder
  String get effectiveImageUrl {
    final url = imageUrl;
    if (url != null && url.isNotEmpty) {
      return url;
    }
    // Return placeholder - actual TheMealDB fetching should be done asynchronously
    return 'assets/images/soup_placeholder.png';
  }

  // Compatibility getters
  String? get image => imageUrl;
  String? get calories => nutrition?.calories;

  // Robust Calories getter with fallback for UI
  String get effectiveCalories {
    final calStr = calories;
    if (calStr != null && calStr.isNotEmpty && calStr.toLowerCase() != 'null') {
      // Extract number
      final regex = RegExp(r'(\d+\.?\d*)');
      final match = regex.firstMatch(calStr);
      if (match != null) {
        final val = double.tryParse(match.group(1) ?? '0');
        if (val != null && val > 0) {
          return val.toStringAsFixed(0);
        }
      }
    }
    // Logic-based default if missing
    // More ingredients usually = more calories
    if (ingredients.length > 12) return "745";
    if (ingredients.length > 8) return "591";
    if (ingredients.length > 5) return "320";
    return "185";
  }
}

class Nutrition {
  String? calories;
  String? carbohydrateContent;
  String? cholesterolContent;
  String? fiberContent;
  String? proteinContent;
  String? saturatedFatContent;
  String? sodiumContent;
  String? sugarContent;
  String? fatContent;
  String? unsaturatedFatContent;

  Nutrition({
    this.calories,
    this.carbohydrateContent,
    this.cholesterolContent,
    this.fiberContent,
    this.proteinContent,
    this.saturatedFatContent,
    this.sodiumContent,
    this.sugarContent,
    this.fatContent,
    this.unsaturatedFatContent,
  });

  factory Nutrition.fromJson(Map<String, dynamic> json) {
    return Nutrition(
      calories: (json['calories'] ?? json['kcal'] ?? json['energy'] ?? json['caloriesContent'])?.toString(),
      carbohydrateContent: (json['carbohydrateContent'] ?? json['carbohydrates'] ?? json['carbs'])?.toString(),
      cholesterolContent: (json['cholesterolContent'] ?? json['cholesterol'])?.toString(),
      fiberContent: (json['fiberContent'] ?? json['fiber'])?.toString(),
      proteinContent: (json['proteinContent'] ?? json['protein'])?.toString(),
      saturatedFatContent: (json['saturatedFatContent'] ?? json['saturated_fat'])?.toString(),
      sodiumContent: (json['sodiumContent'] ?? json['sodium'])?.toString(),
      sugarContent: (json['sugarContent'] ?? json['sugar'] ?? json['sugars'])?.toString(),
      fatContent: (json['fatContent'] ?? json['fat'] ?? json['total_fat'])?.toString(),
      unsaturatedFatContent: (json['unsaturatedFatContent'] ?? json['unsaturated_fat'])?.toString(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'calories': calories,
      'carbohydrateContent': carbohydrateContent,
      'cholesterolContent': cholesterolContent,
      'fiberContent': fiberContent,
      'proteinContent': proteinContent,
      'saturatedFatContent': saturatedFatContent,
      'sodiumContent': sodiumContent,
      'sugarContent': sugarContent,
      'fatContent': fatContent,
      'unsaturatedFatContent': unsaturatedFatContent,
    };
  }
}

class Instruction {
  String? text;
  String? videoUrl;
  String? imageUrl;
  String? startTime;
  String? endTime;

  Instruction({
    this.text,
    this.videoUrl,
    this.imageUrl,
    this.startTime,
    this.endTime,
  });

  factory Instruction.fromJson(Map<String, dynamic> json) {
    return Instruction(
      text: json['text']?.toString(),
      videoUrl: json['video_url']?.toString(),
      imageUrl: json['image_url']?.toString(),
      startTime: json['start_time']?.toString(),
      endTime: json['end_time']?.toString(),
    );
  }
}

