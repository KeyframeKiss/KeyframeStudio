// Bloom: bright areas glow. A soft threshold, then a pyramid down and back up (each level a wider glow), then added
// back with its own saturation and tint.
Shader "Hidden/KeyframeStudio/Bloom"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfBloomTex ("", 2D) = "black" {}
    }
    CGINCLUDE
    #include "KfCommon.cginc"

    sampler2D _KfBloomTex;
    float4 _KfBloomPre;     // x threshold, y softness (knee), z brightest allowed
    float4 _KfBloomCombine; // x intensity, y saturation (1 = as is), z wide (weight of each wider level)
    float4 _KfBloomTint;    // rgb

    half3 Box4(sampler2D t, float2 uv, float4 texel)
    {
        float4 o = texel.xyxy * float4(-1, -1, 1, 1);
        return (tex2D(t, uv + o.xy).rgb + tex2D(t, uv + o.zy).rgb + tex2D(t, uv + o.xw).rgb + tex2D(t, uv + o.zw).rgb) * 0.25;
    }

    half3 Tent(sampler2D t, float2 uv, float4 texel)
    {
        float4 d = texel.xyxy * float4(1, 1, -1, 0);
        half3 s = tex2D(t, uv - d.xy).rgb;
        s += tex2D(t, uv - d.wy).rgb * 2;
        s += tex2D(t, uv - d.zy).rgb;
        s += tex2D(t, uv + d.zw).rgb * 2;
        s += tex2D(t, uv).rgb * 4;
        s += tex2D(t, uv + d.xw).rgb * 2;
        s += tex2D(t, uv + d.zy).rgb;
        s += tex2D(t, uv + d.wy).rgb * 2;
        s += tex2D(t, uv + d.xy).rgb;
        return s / 16;
    }

    // 0: the bright parts, half size
    fixed4 fragPre(v2f i) : SV_Target
    {
        half3 c = Box4(_MainTex, i.uv, _MainTex_TexelSize);
        float br = max(c.r, max(c.g, c.b));
        float knee = max(1e-4, _KfBloomPre.x * _KfBloomPre.y);
        float soft = clamp(br - _KfBloomPre.x + knee, 0, 2 * knee);
        soft = soft * soft / (4 * knee + 1e-5);
        float keep = max(soft, br - _KfBloomPre.x) / max(br, 1e-5);
        return fixed4(min(c * keep, _KfBloomPre.z), 1);
    }

    // 1: down one level
    fixed4 fragDown(v2f i) : SV_Target { return fixed4(Box4(_MainTex, i.uv, _MainTex_TexelSize), 1); }

    // 2: up one level: this level plus the wider ones below it
    fixed4 fragUp(v2f i) : SV_Target
    {
        return fixed4(tex2D(_KfBloomTex, i.uv).rgb + Tent(_MainTex, i.uv, _MainTex_TexelSize) * _KfBloomCombine.z, 1);
    }

    // 3: onto the picture
    fixed4 fragCombine(v2f i) : SV_Target
    {
        fixed4 src = tex2D(_MainTex, i.uv);
        float3 b = tex2D(_KfBloomTex, i.uv).rgb * _KfBloomCombine.x;
        b = lerp(Luma(b).xxx, b, _KfBloomCombine.y) * _KfBloomTint.rgb;
        return fixed4(src.rgb + b, src.a);
    }
    ENDCG

    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragPre
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragDown
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragUp
            #pragma target 3.0
            ENDCG }
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragCombine
            #pragma target 3.0
            ENDCG }
    }
    Fallback Off
}
