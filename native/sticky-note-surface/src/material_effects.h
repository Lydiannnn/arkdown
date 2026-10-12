#pragma once

#include <d2d1effects.h>
#include <windows.graphics.effects.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Effects.h>
#include <winrt/Windows.UI.Composition.h>

#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace sticky_note_material {
using winrt::Windows::Foundation::IPropertyValue;
using winrt::Windows::Foundation::PropertyValue;
using winrt::Windows::Graphics::Effects::IGraphicsEffect;
using winrt::Windows::Graphics::Effects::IGraphicsEffectSource;
namespace effect_abi = ABI::Windows::Graphics::Effects;
namespace composition = winrt::Windows::UI::Composition;

struct Appearance {
  std::string tintColor = "#F3F3F3";
  uint8_t red = 243;
  uint8_t green = 243;
  uint8_t blue = 243;
  double tintOpacity = 0;
  double luminosityOpacity = 0;
  double saturation = 1;

  bool IsRaw() const noexcept { return tintOpacity == 0 && luminosityOpacity == 0 && saturation == 1; }
  bool operator==(const Appearance&) const = default;
  winrt::Windows::UI::Color Color(double opacity) const noexcept {
    return {static_cast<uint8_t>(std::lround(opacity * 255)), red, green, blue};
  }
};

// Describe built-in Direct2D effects to Windows Composition. These are SDK
// interfaces and system effects; there is no Win2D or Windows App SDK runtime.
struct Effect : winrt::implements<Effect, IGraphicsEffect, IGraphicsEffectSource,
  effect_abi::IGraphicsEffectD2D1Interop> {
  Effect(GUID id, winrt::hstring name, winrt::hstring propertyName, IPropertyValue property,
    std::vector<IGraphicsEffectSource> sources)
    : id_(id), name_(std::move(name)), propertyName_(std::move(propertyName)),
      property_(std::move(property)), sources_(std::move(sources)) {}

  winrt::hstring Name() const { return name_; }
  void Name(winrt::hstring const& name) { name_ = name; }
  HRESULT __stdcall GetEffectId(GUID* id) noexcept override {
    if (!id) return E_POINTER;
    *id = id_; return S_OK;
  }
  HRESULT __stdcall GetNamedPropertyMapping(LPCWSTR name, UINT* index,
    effect_abi::GRAPHICS_EFFECT_PROPERTY_MAPPING* mapping) noexcept override {
    if (!name || !index || !mapping) return E_POINTER;
    if (CompareStringOrdinal(name, -1, propertyName_.c_str(), -1, TRUE) != CSTR_EQUAL) return E_INVALIDARG;
    *index = 0; *mapping = effect_abi::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT; return S_OK;
  }
  HRESULT __stdcall GetPropertyCount(UINT* count) noexcept override {
    if (!count) return E_POINTER;
    *count = 1; return S_OK;
  }
  HRESULT __stdcall GetProperty(UINT index, ABI::Windows::Foundation::IPropertyValue** value) noexcept override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (index != 0) return E_BOUNDS;
    return reinterpret_cast<IUnknown*>(winrt::get_abi(property_))->QueryInterface(IID_PPV_ARGS(value));
  }
  HRESULT __stdcall GetSourceCount(UINT* count) noexcept override {
    if (!count) return E_POINTER;
    *count = static_cast<UINT>(sources_.size()); return S_OK;
  }
  HRESULT __stdcall GetSource(UINT index, effect_abi::IGraphicsEffectSource** source) noexcept override {
    if (!source) return E_POINTER;
    *source = nullptr;
    if (index >= sources_.size()) return E_BOUNDS;
    return reinterpret_cast<IUnknown*>(winrt::get_abi(sources_[index]))->QueryInterface(IID_PPV_ARGS(source));
  }

 private:
  GUID id_;
  winrt::hstring name_;
  winrt::hstring propertyName_;
  IPropertyValue property_;
  std::vector<IGraphicsEffectSource> sources_;
};

struct Material {
  composition::CompositionEffectFactory factory{nullptr};
  composition::CompositionEffectBrush brush{nullptr};
  composition::CompositionColorBrush luminosity{nullptr};
  composition::CompositionColorBrush tint{nullptr};

  void Update(const Appearance& appearance) const {
    // CompositionColorBrush owns alpha premultiplication. Color uses the same
    // byte-alpha precision as the Windows material controllers' Color values.
    luminosity.Color(appearance.Color(appearance.luminosityOpacity));
    tint.Color(appearance.Color(appearance.tintOpacity));
    brush.Properties().InsertScalar(L"WallpaperSaturation.Saturation", static_cast<float>(appearance.saturation));
  }

  static Material CreateInstance(const composition::Compositor& compositor,
    const composition::CompositionEffectFactory& factory,
    const composition::CompositionBackdropBrush& wallpaper, const Appearance& appearance) {
    Material result;
    result.factory = factory;
    result.brush = result.factory.CreateBrush();
    result.luminosity = compositor.CreateColorBrush(appearance.Color(appearance.luminosityOpacity));
    result.tint = compositor.CreateColorBrush(appearance.Color(appearance.tintOpacity));
    result.brush.SetSourceParameter(L"Wallpaper", wallpaper);
    result.brush.SetSourceParameter(L"LuminosityColor", result.luminosity);
    result.brush.SetSourceParameter(L"TintColor", result.tint);
    result.Update(appearance);
    return result;
  }

  static Material Create(const composition::Compositor& compositor,
    const composition::CompositionBackdropBrush& wallpaper, const Appearance& appearance) {
    auto saturation = winrt::make<Effect>(CLSID_D2D1Saturation, L"WallpaperSaturation", L"Saturation",
      PropertyValue::CreateSingle(static_cast<float>(appearance.saturation)).as<IPropertyValue>(),
      std::vector<IGraphicsEffectSource>{composition::CompositionEffectSourceParameter{L"Wallpaper"}});

    // Follow the native luminosity-then-tint subgraph in Microsoft's
    // AcrylicBrush.cpp (CombineNoiseWithTintEffect_Luminosity). That source
    // documents the historical Color/Luminosity enum-name inversion; retain
    // its actual enum order. This is a custom wallpaper recipe, not a promise
    // of pixel identity with the private/current MicaController recipe.
    auto luminosityBlend = winrt::make<Effect>(CLSID_D2D1Blend, L"LuminosityBlend", L"Mode",
      PropertyValue::CreateUInt32(D2D1_BLEND_MODE_COLOR).as<IPropertyValue>(),
      std::vector<IGraphicsEffectSource>{saturation.as<IGraphicsEffectSource>(),
        composition::CompositionEffectSourceParameter{L"LuminosityColor"}});
    auto tintBlend = winrt::make<Effect>(CLSID_D2D1Blend, L"TintBlend", L"Mode",
      PropertyValue::CreateUInt32(D2D1_BLEND_MODE_LUMINOSITY).as<IPropertyValue>(),
      std::vector<IGraphicsEffectSource>{luminosityBlend.as<IGraphicsEffectSource>(),
        composition::CompositionEffectSourceParameter{L"TintColor"}});

    const auto factory = compositor.CreateEffectFactory(tintBlend, {L"WallpaperSaturation.Saturation"});
    return CreateInstance(compositor, factory, wallpaper, appearance);
  }
};
}
