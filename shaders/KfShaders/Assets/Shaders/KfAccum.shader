// Quality stills: many renders added together (each weighted 1 / count) into a float picture; the scene's depth;
// two lens pictures focused at two distances joined where each is sharper (focus stacking).
Shader "Hidden/KeyframeStudio/Accum"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _KfTexB ("", 2D) = "white" {}
        _KfDepth ("", 2D) = "white" {}
    }
    CGINCLUDE
    #include "KfCommon.cginc"

    sampler2D_float _CameraDepthTexture;
    sampler2D _KfTexB;
    sampler2D_float _KfDepth;
    float _KfWeight;
    float4 _KfStack; // x first focus (m), y second focus (m), z softness of the join (dioptres)

    // 0: add one render, weighted
    float4 fragAdd(v2f i) : SV_Target { return tex2D(_MainTex, i.uv) * _KfWeight; }

    // 1: the depth (metres from the camera) of the render just made
    float4 fragDepth(v2f i) : SV_Target
    {
        float d = LinearEyeDepth(SAMPLE_DEPTH_TEXTURE(_CameraDepthTexture, i.uvDepth));
        return float4(d, d, d, 1);
    }

    // 2: two pictures focused at two distances: each pixel from the one whose focus is nearer (in dioptres)
    float4 fragStack(v2f i) : SV_Target
    {
        float4 a = tex2D(_MainTex, i.uv);
        float4 b = tex2D(_KfTexB, i.uv);
        float d = max(0.01, tex2D(_KfDepth, i.uv).r);
        float e1 = abs(1 / d - 1 / _KfStack.x);
        float e2 = abs(1 / d - 1 / _KfStack.y);
        float w = saturate((e1 - e2) / max(1e-4, _KfStack.z) + 0.5);
        return lerp(a, b, w);
    }
    ENDCG

    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            Blend One One
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragAdd
            #pragma target 3.0
            ENDCG
        }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragDepth
            #pragma target 3.0
            ENDCG
        }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragStack
            #pragma target 3.0
            ENDCG
        }
    }
    Fallback Off
}
